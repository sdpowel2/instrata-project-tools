/**
 * D-Tools SI API Catalog Sync
 *
 * Endpoint: GET https://api.d-tools.com/SI/Subscribe/Catalogs
 * Auth: X-DTSI-ApiKey header
 *
 * The D-Tools API is queue-based — SI must first export catalog items
 * to the API queue before they are available for subscription.
 * Export can be triggered manually in SI or automated via SI's
 * catalog automation setting (batches of up to 5,000 items).
 *
 * Intended flow:
 * 1. D-Tools SI exports catalog changes to API queue (manual or automated)
 * 2. Webhook fires to Instrata with { type: "Product", id: "...", updatedOn: "..." }
 * 3. Instrata calls GET /Subscribe/Catalogs?id={id} to fetch the changed record
 * 4. Record is upserted into product_catalog via the same upsert logic as CSV import
 * 5. Mark as imported via PUT /Subscribe/Catalogs/MarkAsImported?id={id}
 *
 * API Key is stored in: DTOOLS_API_KEY (environment variable)
 */
export async function syncFromDToolsAPI(): Promise<void> {
  // TODO: implement webhook receiver + polling fallback
  throw new Error('D-Tools API sync not yet implemented — use CSV import for now');
}
