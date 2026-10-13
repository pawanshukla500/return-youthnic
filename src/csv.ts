// CSV helpers for the client-side exports (Reports and Claims).
// Every cell is quoted and embedded quotes are doubled, the same rule as the server's /api/returns/export.

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const cell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`
  const all: (string | number)[][] = [headers, ...rows]
  return all.map((row) => row.map(cell).join(",")).join("\n") + "\n"
}

// Starts a browser download of CSV text.
export function saveCsv(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
