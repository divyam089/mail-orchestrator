export type LeadRecord = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  timezone?: string | null;
  custom?: Record<string, string>;
  lineNumber: number;
};

export type FieldMapping = {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  timezone?: string;
  /** Custom variable name -> CSV header. */
  custom?: Record<string, string>;
};

export type CsvTable = {
  headers: string[];
  rows: { lineNumber: number; cells: string[] }[];
};

/** RFC-style CSV: commas, quotes, and "" escapes. */
export function parseCsvTable(text: string): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let rowStartLine = 1;
  let line = 1;
  const lineOfRow: number[] = [];

  const pushRow = () => {
    row.push(field);
    field = "";
    if (row.some((cell) => cell.trim() !== "")) {
      rows.push(row);
      lineOfRow.push(rowStartLine);
    }
    row = [];
    rowStartLine = line + 1;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      pushRow();
      line += 1;
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((cell) => cell.trim());
  return {
    headers,
    rows: rows.slice(1).map((cells, index) => ({ lineNumber: lineOfRow[index + 1], cells })),
  };
}

function headerIndex(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  headers.forEach((header, index) => {
    const key = header.trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

function cell(cells: string[], index: number | undefined): string {
  if (index == null) return "";
  return (cells[index] ?? "").trim();
}

export function mapCsv(text: string, mapping: FieldMapping): LeadRecord[] {
  const table = parseCsvTable(text);
  if (table.headers.length === 0) throw new Error("CSV is empty. The first row must be the header.");
  const columns = headerIndex(table.headers);
  const emailIndex = columns.get(mapping.email.trim().toLowerCase());
  if (emailIndex == null) throw new Error(`CSV has no "${mapping.email}" column.`);

  const pick = (name: string | undefined) => {
    if (!name?.trim()) return undefined;
    const index = columns.get(name.trim().toLowerCase());
    if (index == null) throw new Error(`CSV has no "${name}" column.`);
    return index;
  };
  const first = pick(mapping.firstName);
  const last = pick(mapping.lastName);
  const company = pick(mapping.company);
  const title = pick(mapping.title);
  const timezone = pick(mapping.timezone);
  const customColumns = Object.entries(mapping.custom ?? {}).map(([variable, header]) => {
    const index = columns.get(header.trim().toLowerCase());
    if (index == null) throw new Error(`CSV has no "${header}" column.`);
    return { variable: variable.trim(), index };
  });

  return table.rows.map((row) => {
    const custom: Record<string, string> = {};
    for (const column of customColumns) {
      const value = cell(row.cells, column.index);
      if (value && column.variable) custom[column.variable] = value;
    }
    return {
      email: cell(row.cells, emailIndex),
      firstName: cell(row.cells, first) || null,
      lastName: cell(row.cells, last) || null,
      company: cell(row.cells, company) || null,
      title: cell(row.cells, title) || null,
      timezone: cell(row.cells, timezone) || null,
      custom,
      lineNumber: row.lineNumber,
    };
  });
}

/** One address per line. `Name <email>` fills first and last name. */
export function parsePaste(text: string): LeadRecord[] {
  const records: LeadRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const named = trimmed.match(/^(.*)<([^<>]+)>\s*$/);
    if (named && named[1].trim()) {
      const name = named[1].replace(/^["']|["']$/g, "").trim();
      const parts = name.split(/\s+/).filter(Boolean);
      records.push({
        email: named[2].trim(),
        firstName: parts[0] ?? null,
        lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
        lineNumber: i + 1,
      });
    } else {
      records.push({ email: trimmed, lineNumber: i + 1 });
    }
  }
  return records;
}
