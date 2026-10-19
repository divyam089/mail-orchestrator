"use client";

import { useMemo, useState } from "react";
import { parseCsvTable, type FieldMapping } from "@/lib/contacts/parse-leads";
import type { ImportDesk as DeskData, HoldItem } from "@/lib/contacts/desk";
import type { ImportReport } from "@/lib/contacts/import";

const FIELDS = [
  { key: "email", label: "Email" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "company", label: "Company" },
  { key: "title", label: "Title" },
  { key: "timezone", label: "Timezone" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-line bg-card px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="font-mono text-2xl">{value}</div>
    </div>
  );
}

export function ImportDesk({ initial, loadError }: { initial: DeskData | null; loadError: string | null }) {
  const [source, setSource] = useState<"paste" | "csv">("paste");
  const [text, setText] = useState("Jane Doe <jane.doe+sales@gmail.com>\njane@acme.test");
  const [tags, setTags] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [mapping, setMapping] = useState<Record<FieldKey, string>>({
    email: "",
    firstName: "",
    lastName: "",
    company: "",
    title: "",
    timezone: "",
  });
  const [customOn, setCustomOn] = useState<Record<string, boolean>>({});
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(loadError);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<HoldItem[]>(initial?.pending ?? []);
  const [recent, setRecent] = useState(initial?.recent ?? []);
  const [policy, setPolicy] = useState(
    initial
      ? { provider: initial.verificationProvider, mxPass: initial.treatMxPassAsValid }
      : { provider: "TODO: verification provider", mxPass: false },
  );

  const headers = useMemo(() => (source === "csv" ? parseCsvTable(text).headers : []), [source, text]);

  function onFile(file: File | undefined) {
    if (!file) return;
    file.text().then((value) => {
      setSource("csv");
      setText(value);
      const found = parseCsvTable(value).headers;
      setMapping((current) => ({
        ...current,
        email: found.find((header) => /mail/i.test(header)) ?? found[0] ?? "",
      }));
      setCustomOn(Object.fromEntries(found.map((header) => [header, false])));
    });
  }

  async function refreshDesk() {
    const response = await fetch("/api/holds");
    if (!response.ok) return;
    const body = (await response.json()) as DeskData;
    setPending(body.pending);
    setRecent(body.recent);
    setPolicy({ provider: body.verificationProvider, mxPass: body.treatMxPassAsValid });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const fieldMapping: FieldMapping = { email: mapping.email || "email" };
    if (mapping.firstName) fieldMapping.firstName = mapping.firstName;
    if (mapping.lastName) fieldMapping.lastName = mapping.lastName;
    if (mapping.company) fieldMapping.company = mapping.company;
    if (mapping.title) fieldMapping.title = mapping.title;
    if (mapping.timezone) fieldMapping.timezone = mapping.timezone;
    const custom: Record<string, string> = {};
    for (const [header, on] of Object.entries(customOn)) {
      if (on) custom[header.trim().toLowerCase().replace(/\s+/g, "_")] = header;
    }
    if (Object.keys(custom).length > 0) fieldMapping.custom = custom;
    try {
      const response = await fetch("/api/imports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source,
          text,
          mapping: source === "csv" ? fieldMapping : undefined,
          tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          campaignName,
        }),
      });
      const body = (await response.json()) as ImportReport & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Import failed");
        setReport(null);
      } else {
        setReport(body);
        await refreshDesk();
      }
    } catch {
      setError("Import failed. The server did not respond.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, action: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/holds/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) setError(body.error ?? "Could not update that hold");
      await refreshDesk();
    } catch {
      setError("Could not update that hold.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted">Step 3 of 8 · Verify and dedupe</p>
      <h1 className="font-display mt-2 max-w-3xl text-4xl leading-tight sm:text-5xl">Import leads. Do not send them.</h1>
      <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
        One contact per normalized address. Other spellings stay as aliases. Provider:{" "}
        <span className="text-ink">{policy.provider}</span>. MX-pass as valid is {policy.mxPass ? "on" : "off"}. Only a
        valid address is enrolled. Risky and unknown addresses land on the hold list, and approve or reject is written
        to the audit log.
      </p>

      {error ? <p className="mt-6 border border-rust/40 bg-card px-4 py-3 text-sm text-rust">{error}</p> : null}

      <section className="mt-8 border border-line bg-card p-4">
        <div className="flex flex-wrap gap-2">
          {(["paste", "csv"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`border px-3 py-1 text-sm ${source === mode ? "border-ink bg-ink text-paper" : "border-line"}`}
              onClick={() => setSource(mode)}
            >
              {mode === "paste" ? "Paste" : "CSV"}
            </button>
          ))}
          <label className="cursor-pointer border border-line px-3 py-1 text-sm">
            Upload CSV
            <input
              className="sr-only"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(event) => onFile(event.target.files?.[0])}
            />
          </label>
        </div>

        <label className="mt-4 block text-sm">
          <span className="text-muted">{source === "csv" ? "CSV, header on the first row" : "One address per line"}</span>
          <textarea
            className="mt-1 min-h-36 w-full border border-line bg-paper px-3 py-2 font-mono text-sm"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>

        {source === "csv" && headers.length > 0 ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map((field) => (
              <label key={field.key} className="text-sm">
                <span className="text-muted">{field.label}</span>
                <select
                  className="mt-1 w-full border border-line bg-paper px-2 py-1"
                  value={mapping[field.key]}
                  onChange={(event) => setMapping((current) => ({ ...current, [field.key]: event.target.value }))}
                >
                  <option value="">{field.key === "email" ? "Choose a column" : "Skip"}</option>
                  {headers.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        ) : null}

        {source === "csv" && headers.length > 0 ? (
          <fieldset className="mt-4">
            <legend className="text-sm text-muted">Custom variables</legend>
            <div className="mt-2 flex flex-wrap gap-3">
              {headers.map((header) => (
                <label key={header} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={customOn[header] ?? false}
                    onChange={(event) => setCustomOn((current) => ({ ...current, [header]: event.target.checked }))}
                  />
                  {header}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-muted">List tags, comma separated</span>
            <input
              className="mt-1 w-full border border-line bg-paper px-3 py-2"
              value={tags}
              placeholder="founders, october"
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="text-muted">Draft campaign name, optional</span>
            <input
              className="mt-1 w-full border border-line bg-paper px-3 py-2"
              value={campaignName}
              placeholder="October sequence"
              onChange={(event) => setCampaignName(event.target.value)}
            />
          </label>
        </div>

        <button
          type="button"
          className="mt-4 border border-ink bg-ink px-4 py-2 text-sm text-paper disabled:opacity-50"
          disabled={busy || (source === "csv" && !mapping.email)}
          onClick={() => void submit()}
        >
          {busy ? "Working" : "Import"}
        </button>
      </section>

      {report ? (
        <section className="mt-8">
          <h2 className="text-sm font-medium">Dedupe report</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Count label="New" value={report.counts.new} />
            <Count label="Duplicate in file" value={report.counts.duplicate_in_file} />
            <Count label="Already in system" value={report.counts.already_in_system} />
            <Count label="Invalid" value={report.counts.invalid} />
            <Count label="Suppressed" value={report.counts.suppressed} />
          </div>
          <ul className="mt-4 divide-y divide-line border border-line bg-card">
            {report.rows.slice(0, 30).map((row) => (
              <li key={`${row.lineNumber}-${row.raw}`} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="break-all font-mono text-xs">{row.raw || "(blank)"}</span>
                  <span className="text-xs uppercase tracking-[0.12em] text-muted">{row.bucket.replaceAll("_", " ")}</span>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {row.verificationStatus ? `${row.verificationStatus} · ` : ""}
                  {row.detail}
                  {row.enrolled ? " · enrolled" : ""}
                  {row.held ? " · on hold" : ""}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-sm font-medium">Hold list</h2>
        {pending.length === 0 ? (
          <p className="mt-3 border border-line bg-card px-4 py-3 text-sm text-muted">No risky or unknown addresses are waiting.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line border border-line bg-card">
            {pending.map((hold) => (
              <li key={hold.id} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="break-all font-mono text-xs">{hold.email}</div>
                  <div className="mt-1 text-xs text-muted">
                    {hold.verificationStatus} · {hold.reason}
                    {hold.campaignName ? ` · ${hold.campaignName}` : ""} · {hold.createdAt}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="border border-moss px-3 py-1 text-sm text-moss disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void decide(hold.id, "approve")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="border border-rust px-3 py-1 text-sm text-rust disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void decide(hold.id, "reject")}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {recent.length > 0 ? (
          <ul className="mt-3 space-y-1 text-xs text-muted">
            {recent.map((item) => (
              <li key={item.id}>
                {item.status} {item.email} · {item.decidedBy ?? "operator"} · {item.decidedAt}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
