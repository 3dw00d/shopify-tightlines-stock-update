import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

const MAX_ROWS = 1000;
const SKU_CHUNK_SIZE = 25;
const METAFIELD_BATCH_SIZE = 25;
const VARIANT_BATCH_SIZE = 250;
const THRESHOLD_NAMESPACE = 'sidekick';
const THRESHOLD_KEY = 'special_order_threshold';

type ParsedRow = {
  line: number;
  sku: string;
  price: number;
  stock: number | null;
};

type SkippedRow = {
  line: number;
  text: string;
  reason: string;
};

type MatchRow = {
  variantId: string;
  productId: string;
  productTitle: string;
  displayName: string;
  sku: string;
  currentCost: number | null;
  newCost: number;
  stock: number | null;
  inventoryPolicy: string;
  thresholdFromShopify: number | null;
  thresholdSource: 'custom' | 'sidekick' | 'none';
};

const DEFINITION_QUERY = `query ThresholdDefinition($identifier: MetafieldDefinitionIdentifierInput!) {
  metafieldDefinition(identifier: $identifier) {
    id
  }
}`;

const DEFINITION_CREATE_MUTATION = `mutation CreateThresholdDefinition($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition {
      id
    }
    userErrors {
      field
      message
      code
    }
  }
}`;

const VARIANTS_QUERY = `query VariantsBySku($query: String!, $after: String) {
  productVariants(first: 250, query: $query, after: $after) {
    edges {
      node {
        id
        sku
        displayName
        inventoryPolicy
        inventoryQuantity
        inventoryItem {
          id
          unitCost {
            amount
          }
        }
        product {
          id
          title
          sidekickThreshold: metafield(namespace: "sidekick", key: "special_order_threshold") {
            jsonValue
          }
          customThreshold: metafield(namespace: "custom", key: "special_order_threshold") {
            jsonValue
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const METAFIELDS_SET_MUTATION = `mutation SetThresholds($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields {
      id
    }
    userErrors {
      field
      message
      code
    }
  }
}`;

const VARIANTS_BULK_UPDATE_MUTATION = `mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants {
      id
      inventoryPolicy
      inventoryItem {
        unitCost {
          amount
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}`;

function formatUserErrors(userErrors: any[]): string {
  return userErrors
    .map((e: any) => {
      const fieldPath: string = Array.isArray(e.field) ? e.field.join('.') : e.field || '';
      return fieldPath ? `${fieldPath}: ${e.message}` : e.message;
    })
    .join(', ');
}

function formatErrors(errors: any[]): string {
  return errors.map((e: any) => e.message).join(', ');
}

function parsePrice(raw: string): number {
  const cleaned: string = raw.replace(/[^0-9.\-]/g, '');
  return parseFloat(cleaned);
}

function parseStock(raw: string): number | null {
  const match = raw.trim().match(/-?\d+/);
  if (!match) return null;
  const value: number = parseInt(match[0], 10);
  return Number.isNaN(value) ? null : value;
}

function parseThreshold(jsonValue: any): number | null {
  if (jsonValue === null || jsonValue === undefined || jsonValue === '') return null;
  const value: number = typeof jsonValue === 'number' ? jsonValue : parseInt(String(jsonValue), 10);
  return Number.isNaN(value) ? null : value;
}

function parseInput(text: string): {
  rows: ParsedRow[];
  skipped: SkippedRow[];
  truncated: boolean;
} {
  const lines: string[] = text.split(/\r?\n/);
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  let truncated: boolean = false;

  for (let i = 0; i < lines.length; i++) {
    const raw: string = lines[i];
    if (raw.trim() === '') continue;

    const cells: string[] = (raw.indexOf('\t') >= 0 ? raw.split('\t') : raw.split(',')).map((c) =>
      c.trim(),
    );

    if (cells[0] && cells[0].toLowerCase() === 'code') continue;

    if (cells.length < 3) {
      skipped.push({ line: i + 1, text: raw.trim(), reason: 'Fewer than 3 columns' });
      continue;
    }

    const sku: string = cells[0];
    const price: number = parsePrice(cells[1]);

    if (!sku) {
      skipped.push({ line: i + 1, text: raw.trim(), reason: 'Missing code' });
      continue;
    }

    if (Number.isNaN(price)) {
      skipped.push({ line: i + 1, text: raw.trim(), reason: 'Price is not a number' });
      continue;
    }

    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }

    rows.push({ line: i + 1, sku, price, stock: parseStock(cells[2]) });
  }

  return { rows, skipped, truncated };
}

function escapeSku(sku: string): string {
  return sku.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function Extension() {
  const [inputText, setInputText] = useState<string>('');
  const [matching, setMatching] = useState<boolean>(false);
  const [applying, setApplying] = useState<boolean>(false);
  const [progress, setProgress] = useState<string>('');
  const [criticalError, setCriticalError] = useState<string>('');
  const [failureMessages, setFailureMessages] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string>('');
  const [skippedRows, setSkippedRows] = useState<SkippedRow[]>([]);
  const [truncatedNotice, setTruncatedNotice] = useState<boolean>(false);
  const [unmatchedSkus, setUnmatchedSkus] = useState<string[]>([]);
  const [unmatchedDismissed, setUnmatchedDismissed] = useState<boolean>(false);
  const [rowsParsedCount, setRowsParsedCount] = useState<number>(0);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [thresholdEdits, setThresholdEdits] = useState<Record<string, string>>({});
  const [thresholdEditingEnabled, setThresholdEditingEnabled] = useState<boolean>(true);
  const [hasRun, setHasRun] = useState<boolean>(false);

  const ensureDefinition = async (): Promise<void> => {
    try {
      const { data, errors } = await shopify.query(DEFINITION_QUERY, {
        variables: {
          identifier: { ownerType: 'PRODUCT', namespace: THRESHOLD_NAMESPACE, key: THRESHOLD_KEY },
        },
      });

      if (errors?.length > 0) {
        setCriticalError(formatErrors(errors));
        setThresholdEditingEnabled(false);
        return;
      }

      if (data?.metafieldDefinition?.id) return;

      const { data: createData, errors: createErrors } = await shopify.query(
        DEFINITION_CREATE_MUTATION,
        {
          variables: {
            definition: {
              name: 'Special Order Threshold',
              namespace: THRESHOLD_NAMESPACE,
              key: THRESHOLD_KEY,
              type: 'number_integer',
              ownerType: 'PRODUCT',
              description:
                'Supplier stock must be at or above this number for the product to stay available for special order.',
              access: { storefront: 'NONE' },
            },
          },
        },
      );

      if (createErrors?.length > 0) {
        setCriticalError(formatErrors(createErrors));
        setThresholdEditingEnabled(false);
        return;
      }

      const defUserErrors = createData?.metafieldDefinitionCreate?.userErrors || [];
      if (defUserErrors.length > 0) {
        setCriticalError(formatUserErrors(defUserErrors));
        setThresholdEditingEnabled(false);
      }
    } catch (err: any) {
      setCriticalError(err?.message || 'Could not check the Special Order Threshold field.');
      setThresholdEditingEnabled(false);
    }
  };

  useEffect(() => {
    ensureDefinition();
  }, []);

  const fetchVariantsForSkus = async (skus: string[]): Promise<any[]> => {
    const queryString: string = skus.map((sku) => `sku:'${escapeSku(sku)}'`).join(' OR ');
    const nodes: any[] = [];
    let cursor: string | null = null;
    let keepGoing: boolean = true;

    while (keepGoing) {
      const { data, errors } = await shopify.query(VARIANTS_QUERY, {
        variables: { query: queryString, after: cursor },
      });

      if (errors?.length > 0) {
        throw new Error(formatErrors(errors));
      }

      const connection = data?.productVariants;
      if (!connection) break;

      connection.edges.forEach((edge: any) => nodes.push(edge.node));

      if (connection.pageInfo?.hasNextPage) {
        cursor = connection.pageInfo.endCursor;
      } else {
        keepGoing = false;
      }
    }

    return nodes;
  };

  const handleMatch = async (): Promise<void> => {
    setMatching(true);
    setCriticalError('');
    setFailureMessages([]);
    setSuccessMessage('');
    setUnmatchedDismissed(false);
    setMatches([]);
    setThresholdEdits({});
    setHasRun(false);

    const parsed = parseInput(inputText);
    setSkippedRows(parsed.skipped);
    setTruncatedNotice(parsed.truncated);
    setRowsParsedCount(parsed.rows.length);

    if (parsed.rows.length === 0) {
      setUnmatchedSkus([]);
      setMatching(false);
      setHasRun(true);
      return;
    }

    const rowsBySku: Record<string, ParsedRow> = {};
    parsed.rows.forEach((row) => {
      rowsBySku[row.sku] = row;
    });
    const uniqueSkus: string[] = Object.keys(rowsBySku);

    try {
      const collected: MatchRow[] = [];
      const foundSkus: Record<string, boolean> = {};

      for (let i = 0; i < uniqueSkus.length; i += SKU_CHUNK_SIZE) {
        const chunk: string[] = uniqueSkus.slice(i, i + SKU_CHUNK_SIZE);
        setProgress(
          `Looking up SKUs ${i + 1}–${Math.min(i + chunk.length, uniqueSkus.length)} of ${uniqueSkus.length}…`,
        );

        const nodes = await fetchVariantsForSkus(chunk);

        nodes.forEach((node: any) => {
          const variantSku: string = (node.sku || '').trim();
          const row = rowsBySku[variantSku];
          if (!row) return;

          foundSkus[variantSku] = true;

          const customValue = parseThreshold(node.product?.customThreshold?.jsonValue);
          const sidekickValue = parseThreshold(node.product?.sidekickThreshold?.jsonValue);
          const effective: number | null = customValue !== null ? customValue : sidekickValue;
          const source: 'custom' | 'sidekick' | 'none' =
            customValue !== null ? 'custom' : sidekickValue !== null ? 'sidekick' : 'none';

          const costAmount = node.inventoryItem?.unitCost?.amount;

          collected.push({
            variantId: node.id,
            productId: node.product.id,
            productTitle: node.product.title,
            displayName: node.displayName,
            sku: variantSku,
            currentCost:
              costAmount === null || costAmount === undefined ? null : parseFloat(costAmount),
            newCost: row.price,
            stock: row.stock,
            inventoryPolicy: node.inventoryPolicy,
            thresholdFromShopify: effective,
            thresholdSource: source,
          });
        });
      }

      collected.sort((a, b) => a.sku.localeCompare(b.sku));
      setMatches(collected);
      setUnmatchedSkus(uniqueSkus.filter((sku) => !foundSkus[sku]));
      setHasRun(true);
    } catch (err: any) {
      setCriticalError(err?.message || 'Could not look up your products.');
    } finally {
      setProgress('');
      setMatching(false);
    }
  };

  const effectiveThreshold = (row: MatchRow): number | null => {
    const edit = thresholdEdits[row.productId];
    if (edit !== undefined) {
      if (edit.trim() === '') return null;
      const parsedEdit: number = parseInt(edit, 10);
      if (Number.isNaN(parsedEdit)) return null;
      return Math.max(0, Math.floor(parsedEdit));
    }
    return row.thresholdFromShopify;
  };

  const shouldTurnOff = (row: MatchRow): boolean => {
    const threshold = effectiveThreshold(row);
    if (threshold === null || row.stock === null) return false;
    if (row.inventoryPolicy !== 'CONTINUE') return false;
    return row.stock < threshold;
  };

  const costChanged = (row: MatchRow): boolean => {
    if (row.currentCost === null) return true;
    return row.currentCost.toFixed(2) !== row.newCost.toFixed(2);
  };

  const costUpdateCount: number = matches.filter((row) => costChanged(row)).length;
  const policyChangeCount: number = matches.filter((row) => shouldTurnOff(row)).length;

  const handleThresholdInput = (productId: string, value: string): void => {
    setThresholdEdits((previous) => ({ ...previous, [productId]: value }));
  };

  const handleApply = async (): Promise<void> => {
    setApplying(true);
    setCriticalError('');
    setFailureMessages([]);
    setSuccessMessage('');

    const collectedFailures: string[] = [];

    try {
      const thresholdPayloads: any[] = [];
      const seenProducts: Record<string, boolean> = {};

      matches.forEach((row) => {
        const edit = thresholdEdits[row.productId];
        if (edit === undefined || seenProducts[row.productId]) return;
        if (edit.trim() === '') return;
        const parsedEdit: number = parseInt(edit, 10);
        if (Number.isNaN(parsedEdit)) return;
        const normalized: number = Math.max(0, Math.floor(parsedEdit));
        if (normalized === row.thresholdFromShopify) return;
        seenProducts[row.productId] = true;
        thresholdPayloads.push({
          ownerId: row.productId,
          namespace: THRESHOLD_NAMESPACE,
          key: THRESHOLD_KEY,
          type: 'number_integer',
          value: String(normalized),
        });
      });

      for (let i = 0; i < thresholdPayloads.length; i += METAFIELD_BATCH_SIZE) {
        const batch = thresholdPayloads.slice(i, i + METAFIELD_BATCH_SIZE);
        setProgress(
          `Saving thresholds ${i + 1}–${i + batch.length} of ${thresholdPayloads.length}…`,
        );

        const { data, errors } = await shopify.query(METAFIELDS_SET_MUTATION, {
          variables: { metafields: batch },
        });

        if (errors?.length > 0) {
          collectedFailures.push(`Thresholds: ${formatErrors(errors)}`);
        } else {
          const metafieldUserErrors = data?.metafieldsSet?.userErrors || [];
          if (metafieldUserErrors.length > 0) {
            collectedFailures.push(`Thresholds: ${formatUserErrors(metafieldUserErrors)}`);
          }
        }
      }

      const groups: Record<string, MatchRow[]> = {};
      matches.forEach((row) => {
        if (!groups[row.productId]) groups[row.productId] = [];
        groups[row.productId].push(row);
      });

      const productIds: string[] = Object.keys(groups);
      const updatedCosts: Record<string, string> = {};
      const updatedPolicies: Record<string, string> = {};
      let costSuccessCount: number = 0;
      let policySuccessCount: number = 0;

      for (let p = 0; p < productIds.length; p++) {
        const productId: string = productIds[p];
        const productRows: MatchRow[] = groups[productId];
        setProgress(`Updating product ${p + 1} of ${productIds.length}…`);

        for (let i = 0; i < productRows.length; i += VARIANT_BATCH_SIZE) {
          const batchRows: MatchRow[] = productRows.slice(i, i + VARIANT_BATCH_SIZE);
          const variantInputs = batchRows.map((row) => {
            const input: any = {
              id: row.variantId,
              inventoryItem: { cost: row.newCost.toFixed(2) },
            };
            if (shouldTurnOff(row)) {
              input.inventoryPolicy = 'DENY';
            }
            return input;
          });

          const { data, errors } = await shopify.query(VARIANTS_BULK_UPDATE_MUTATION, {
            variables: { productId, variants: variantInputs },
          });

          if (errors?.length > 0) {
            collectedFailures.push(`${batchRows[0].productTitle}: ${formatErrors(errors)}`);
            continue;
          }

          const bulkUserErrors = data?.productVariantsBulkUpdate?.userErrors || [];
          if (bulkUserErrors.length > 0) {
            collectedFailures.push(
              `${batchRows[0].productTitle}: ${formatUserErrors(bulkUserErrors)}`,
            );
            continue;
          }

          const returned = data?.productVariantsBulkUpdate?.productVariants || [];
          returned.forEach((variant: any) => {
            const amount = variant.inventoryItem?.unitCost?.amount;
            if (amount !== null && amount !== undefined) {
              updatedCosts[variant.id] = amount;
            }
            updatedPolicies[variant.id] = variant.inventoryPolicy;
          });

          batchRows.forEach((row) => {
            if (costChanged(row)) costSuccessCount += 1;
            if (shouldTurnOff(row)) policySuccessCount += 1;
          });
        }
      }

      setMatches((previous) =>
        previous.map((row) => {
          const newAmount = updatedCosts[row.variantId];
          const newPolicy = updatedPolicies[row.variantId];
          const appliedThreshold = effectiveThreshold(row);
          return {
            ...row,
            currentCost: newAmount === undefined ? row.currentCost : parseFloat(newAmount),
            inventoryPolicy: newPolicy === undefined ? row.inventoryPolicy : newPolicy,
            thresholdFromShopify: appliedThreshold,
            thresholdSource:
              appliedThreshold === null
                ? 'none'
                : row.thresholdSource === 'custom'
                  ? 'custom'
                  : 'sidekick',
          };
        }),
      );
      setThresholdEdits({});

      setFailureMessages(collectedFailures);
      setSuccessMessage(
        `Updated cost on ${costSuccessCount} variant${costSuccessCount === 1 ? '' : 's'} and turned off “Continue selling when out of stock” on ${policySuccessCount} variant${policySuccessCount === 1 ? '' : 's'}.`,
      );
    } catch (err: any) {
      setCriticalError(err?.message || 'Could not apply the updates.');
    } finally {
      setProgress('');
      setApplying(false);
    }
  };

  const matchDisabled: boolean = inputText.trim() === '' || matching || applying;
  const showUnmatched: boolean = unmatchedSkus.length > 0 && !unmatchedDismissed;

  return (
    <s-page id="supplier-cost-sync-page" heading="Supplier Cost Sync">
      {criticalError ? (
        <s-banner id="critical-banner" tone="critical" heading="Something went wrong">
          <s-paragraph id="critical-text">{criticalError}</s-paragraph>
        </s-banner>
      ) : null}

      {failureMessages.length > 0 ? (
        <s-banner id="failure-banner" tone="critical" heading="Some updates failed">
          {failureMessages.map((message, index) => (
            <s-paragraph id={`failure-item-${index}`} key={`failure-${index}`}>
              {message}
            </s-paragraph>
          ))}
        </s-banner>
      ) : null}

      {successMessage ? (
        <s-banner id="success-banner" tone="success" heading="Updates applied">
          <s-paragraph id="success-text">{successMessage}</s-paragraph>
        </s-banner>
      ) : null}

      {truncatedNotice ? (
        <s-banner id="truncated-banner" tone="warning" heading="Too many rows">
          <s-paragraph id="truncated-text">
            Only the first {MAX_ROWS} rows were processed. Split the file and run again.
          </s-paragraph>
        </s-banner>
      ) : null}

      {skippedRows.length > 0 ? (
        <s-banner id="skipped-banner" tone="warning" heading="Rows skipped" dismissible>
          {skippedRows.map((row) => (
            <s-paragraph id={`skipped-item-${row.line}`} key={`skipped-${row.line}`}>
              Line {row.line}: {row.text} ({row.reason})
            </s-paragraph>
          ))}
        </s-banner>
      ) : null}

      {showUnmatched ? (
        <s-banner
          id="unmatched-banner"
          tone="warning"
          heading="SKUs not found"
          dismissible
          onDismiss={() => setUnmatchedDismissed(true)}
        >
          <s-paragraph id="unmatched-text">{unmatchedSkus.join(', ')}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section id="input-section" heading="Supplier data">
        <s-paragraph id="input-help">
          Paste rows of SKU, price and stock to get started. Columns can be separated by tabs or
          commas, and a header row starting with “Code” is ignored.
        </s-paragraph>
        <s-text-area
          id="supplier-input"
          label="Supplier data"
          labelAccessibilityVisibility="exclusive"
          rows={10}
          placeholder={'Code\tPrice\tStock\nTA1973.279\t146.00\t20+'}
          value={inputText}
          autocomplete="off"
          onInput={(event: any) => setInputText(event.currentTarget.value)}
        />
        <s-stack
          id="input-actions"
          direction="inline"
          gap="base"
          justifyContent="start"
          alignItems="center"
        >
          <s-button
            id="match-button"
            variant="primary"
            disabled={matchDisabled}
            loading={matching}
            onClick={handleMatch}
          >
            Match products
          </s-button>
          {progress ? (
            <s-text id="progress-text" color="subdued">
              {progress}
            </s-text>
          ) : null}
        </s-stack>
      </s-section>

      {hasRun ? (
        <s-section id="summary-section" heading="Summary">
          <s-stack id="summary-stack" direction="inline" gap="large" alignItems="center">
            <s-stack id="summary-parsed" direction="block" gap="small-500">
              <s-text id="summary-parsed-label" color="subdued">
                Rows parsed
              </s-text>
              <s-heading id="summary-parsed-value">{String(rowsParsedCount)}</s-heading>
            </s-stack>
            <s-stack id="summary-matched" direction="block" gap="small-500">
              <s-text id="summary-matched-label" color="subdued">
                Variants matched
              </s-text>
              <s-heading id="summary-matched-value">{String(matches.length)}</s-heading>
            </s-stack>
            <s-stack id="summary-missing" direction="block" gap="small-500">
              <s-text id="summary-missing-label" color="subdued">
                SKUs not found
              </s-text>
              <s-heading id="summary-missing-value">{String(unmatchedSkus.length)}</s-heading>
            </s-stack>
            <s-stack id="summary-costs" direction="block" gap="small-500">
              <s-text id="summary-costs-label" color="subdued">
                Cost updates queued
              </s-text>
              <s-heading id="summary-costs-value">{String(costUpdateCount)}</s-heading>
            </s-stack>
            <s-stack id="summary-policies" direction="block" gap="small-500">
              <s-text id="summary-policies-label" color="subdued">
                Continue selling turn-offs
              </s-text>
              <s-heading id="summary-policies-value">{String(policyChangeCount)}</s-heading>
            </s-stack>
          </s-stack>
        </s-section>
      ) : null}

      {matches.length > 0 ? (
        <s-section id="matches-section" padding="none">
          <s-box id="matches-heading-box" padding="base">
            <s-heading id="matches-heading">Proposed changes</s-heading>
          </s-box>
          <s-table id="matches-table" variant="auto">
            <s-table-header-row id="matches-header-row">
              <s-table-header id="header-sku" listSlot="kicker">
                SKU
              </s-table-header>
              <s-table-header id="header-product" listSlot="primary">
                Product
              </s-table-header>
              <s-table-header id="header-current-cost" format="currency" listSlot="labeled">
                Current cost
              </s-table-header>
              <s-table-header id="header-new-cost" format="currency" listSlot="labeled">
                New cost
              </s-table-header>
              <s-table-header id="header-stock" format="numeric" listSlot="labeled">
                Supplier stock
              </s-table-header>
              <s-table-header id="header-threshold" listSlot="labeled">
                Threshold
              </s-table-header>
              <s-table-header id="header-policy" listSlot="inline">
                Continue selling
              </s-table-header>
            </s-table-header-row>
            <s-table-body id="matches-body">
              {matches.map((row) => {
                const key: string = row.variantId.split('/').pop() || row.variantId;
                const threshold = effectiveThreshold(row);
                const editValue =
                  thresholdEdits[row.productId] !== undefined
                    ? thresholdEdits[row.productId]
                    : row.thresholdFromShopify === null
                      ? ''
                      : String(row.thresholdFromShopify);

                return (
                  <s-table-row id={`row-${key}`} key={row.variantId}>
                    <s-table-cell id={`cell-sku-${key}`}>
                      <s-text id={`sku-${key}`}>{row.sku}</s-text>
                    </s-table-cell>
                    <s-table-cell id={`cell-product-${key}`}>
                      <s-link
                        id={`product-link-${key}`}
                        href={`shopify://admin/products?query=${encodeURIComponent(row.sku)}`}
                      >
                        {row.displayName}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell id={`cell-current-cost-${key}`}>
                      {row.currentCost === null ? '—' : row.currentCost.toFixed(2)}
                    </s-table-cell>
                    <s-table-cell id={`cell-new-cost-${key}`}>
                      {costChanged(row) ? (
                        <s-text id={`new-cost-${key}`} type="strong">
                          {row.newCost.toFixed(2)}
                        </s-text>
                      ) : (
                        <s-badge id={`cost-unchanged-${key}`}>Cost unchanged</s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell id={`cell-stock-${key}`}>
                      {row.stock === null ? '—' : String(row.stock)}
                    </s-table-cell>
                    <s-table-cell id={`cell-threshold-${key}`}>
                      <s-number-field
                        id={`threshold-${key}`}
                        label="Threshold"
                        labelAccessibilityVisibility="exclusive"
                        min={0}
                        step={1}
                        value={editValue}
                        disabled={!thresholdEditingEnabled || applying}
                        onInput={(event: any) =>
                          handleThresholdInput(row.productId, event.currentTarget.value)
                        }
                      />
                    </s-table-cell>
                    <s-table-cell id={`cell-policy-${key}`}>
                      {threshold === null ? (
                        <s-text id={`policy-missing-${key}`} color="subdued">
                          Threshold missing
                        </s-text>
                      ) : shouldTurnOff(row) ? (
                        <s-badge id={`policy-off-${key}`} tone="critical">
                          Turn off
                        </s-badge>
                      ) : (
                        <s-text id={`policy-none-${key}`} color="subdued">
                          No change
                        </s-text>
                      )}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}

      {matches.length > 0 ? (
        <s-stack
          id="apply-actions"
          direction="inline"
          gap="base"
          justifyContent="end"
          alignItems="center"
        >
          {progress && applying ? (
            <s-text id="apply-progress" color="subdued">
              {progress}
            </s-text>
          ) : null}
          <s-button
            id="apply-button"
            variant="primary"
            loading={applying}
            disabled={applying || matching}
            onClick={handleApply}
          >
            Apply updates
          </s-button>
        </s-stack>
      ) : null}

      {hasRun && matches.length === 0 ? (
        <s-section id="empty-section">
          <s-stack id="empty-stack" direction="block" gap="base" alignItems="center">
            <s-heading id="empty-heading">No matching variants</s-heading>
            <s-paragraph id="empty-text">
              None of the codes in your data matched a variant SKU. Check the codes and paste the
              data again.
            </s-paragraph>
          </s-stack>
        </s-section>
      ) : null}
    </s-page>
  );
}

export default (): void => render(<Extension />, document.body);
