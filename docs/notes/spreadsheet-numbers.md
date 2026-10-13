# Numbers in uploaded files: what is checked at upload

Last updated: 2026-10-09. Status: implemented and read through. **Not compiled or run.** `server/tests/spreadsheet-numbers.test.ts` builds its workbooks in memory and needs `npm test` to run.

## What the screenshots showed

- **Amazon (Forward and Reverse Leg columns).** In a narrow column Excel shows `3.68E+11` and `6.3E+11`. Widened, the same cells show `368061672124` and `629768421577`. These are 12-digit numbers, which are exact, so they import correctly. The narrow display is only a width effect. A column can also mix text (`AW794044214IN`) with numbers (`14931238950331`), and both import correctly.
- **Flipkart (Order Item ID, Return ID).** Even in a wide column, `Order Item ID` shows `3.39E+17` and `Return ID` shows `1.05E+25`. The real values are 18 and 26 digits. Excel stores a number to 15 significant digits, so the last digits were already lost in the file. Tracking ID and Shipment ID are text and are fine.

Ajio's identifiers are text in the file, so they import as typed.

## Why the digits are lost

- Excel keeps 15 significant digits. A longer number typed or saved in Excel is rounded.
- A JavaScript number holds every integer exactly only up to about 9 quadrillion (9,007,199,254,740,992). Above that the reader itself changes the last digits. For example `338807258310443100` is read back as `338807258310443072`.

So a number with 15 or more digits cannot be trusted as an identifier, whatever the display shows.

## The rule (server/sheets.ts)

- **Detection.** A numeric cell is untrusted when it is not a whole number, or when its value is 1e15 or more (16 or more digits). Only identifier columns are checked, and quantities and amounts are not affected.
- **Lookup key** (tracking column, AWB, Return AWB No, Reverse Leg Tracking ID, and Myntra's AG and AF when used as the key). An untrusted value makes the row **pending and not scannable**. The row is kept in `upload_rows` and is not imported. The message says what to do: re-save as CSV with IDs as text, or upload the marketplace's CSV download.
- **Any other identifier** (order ID, order line, order item, return ID, shipment ID, RMA ID, forward AWB). The value is **left blank** and a warning names it. Nothing is repaired or guessed.
- **Text in scientific notation** (`3.39E+17` in a CSV that was saved from Excel) gets the same treatment: a key is pending and not scannable, and any other identifier is blank with a warning. It is never stored.
- **Meesho AWB, the one exception.** A 16-digit AWB stored as a number is accepted only when the verified Delhivery link confirms it, either exactly or as the 15-digit rounding of the link value (see `resolveTrackingId` in `server/marketplace-rules.ts`). Otherwise it is a row error.
- **Cancelled Myntra rows.** A tracking number that is present but unusable is pending, never a cancellation.

## What the scanner sees

Nothing damaged reaches the scanner. A row with an untrusted key is kept in upload history but is not imported into active lookups, so its AWB returns "not found" and not a wrong return. Blanked fields show "—" in the register. The scanner does not have to judge a number.

## What to do with the files (for the user)

1. Use the marketplace's own CSV download where there is one (Flipkart, Meesho and Amazon have CSV downloads that keep IDs as text). Do not open the report in Excel and save it before upload.
2. If an Excel file must be used, format the identifier columns as Text before the numbers are typed in, or re-download the report.
3. Run the preview before importing. Rows marked pending or rejected are not imported into active lookups. Check the grouped exceptions and warnings for the names of blank fields.

## Limits that remain

- **Leading zeros.** Excel removes leading zeros from a number. A 7-digit AWB `0012345` stored as a number becomes `12345`. The reader cannot see this, so it is not caught. Only text storage prevents it.
- **Existing data.** Lookup rows imported before this change may hold damaged values, for example `3.39E+17` as an order line. A new upload of the same file replaces the active lookup data and fixes them. Scans already saved keep the values they recorded, and they are not changed.
- **Preview.** The preview shows grouped exception rows, scannable/pending/rejected counts and the first five distinct warnings. A separate count of blanked identifiers per column is not built yet.
- **Not verified.** The rule has not been run against a real Flipkart Excel file. Amazon CSV and the Meesho scanner workbook were read-only diagnosed in the 2026-10-10 handoff; no upload was activated.
