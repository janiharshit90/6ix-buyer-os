"use client";

import { useActionState, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { draftChecklistFacts, toPayload, withRowKeys, type OfferDraft } from "@/lib/offers/draft";
import {
  CAP_COUNTS,
  CAP_PERIODS,
  missingFields,
  OFFER_STATUSES,
  OFFER_URL_KINDS,
  PAYOUT_MODELS,
  US_STATES,
  US_TIMEZONES,
  WEEKDAYS,
} from "@/lib/offers/schema";

import { saveOfferDraft, type FormState } from "./actions";

const IDLE: FormState = { status: "idle" };

const FIELD_LABELS: Record<string, string> = {
  "offer.name": "Offer name",
  "offer.advertiserName": "Advertiser",
  "offer.vertical": "Vertical",
  "version.capAmount": "Cap amount",
  "version.feedbackDelayDays": "Feedback delay",
  "version.callHours": "Call hours",
  "version.optimisationEvent": "Optimisation event",
  "economics.targetCpl": "Target CPL",
  "economics.targetRoi": "Target ROI",
  "economics.payoutTiers": "Payout tiers",
  urls: "URLs",
};

function issueLabel(path: string) {
  const exact = FIELD_LABELS[path];
  if (exact) return exact;
  const prefix = Object.keys(FIELD_LABELS)
    .filter((k) => path.startsWith(`${k}.`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? `${FIELD_LABELS[prefix]} (${path.slice(prefix.length + 1)})` : path;
}

const control =
  "border-input h-8 w-full rounded-md border bg-transparent px-2 text-sm shadow-xs focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none";

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
      <legend className="px-1 font-medium">{title}</legend>
      {hint && <p className="text-muted-foreground -mt-1 text-xs">{hint}</p>}
      {children}
    </fieldset>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Select({
  id,
  value,
  onChange,
  options,
  unknown = true,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  unknown?: boolean;
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={control}>
      {unknown && <option value="">unknown</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

export function OfferForm({
  initial,
  advertiserNames,
  submitLabel,
}: {
  initial: OfferDraft;
  advertiserNames: string[];
  submitLabel: string;
}) {
  // Rows get stable client-only keys, so deleting a row doesn't shift focus/state to its neighbour.
  const [d, setD] = useState<OfferDraft>(() => withRowKeys(initial));
  const [state, action, pending] = useActionState(saveOfferDraft, IDLE);
  const set = <K extends keyof OfferDraft>(key: K, value: OfferDraft[K]) =>
    setD((prev) => ({ ...prev, [key]: value }));

  const payload = toPayload(d);
  const missing = missingFields(draftChecklistFacts(payload));

  return (
    <form action={action} className="flex max-w-3xl flex-col gap-6">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />

      {state.status === "error" && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-lg border p-3 text-sm"
        >
          <p className="text-destructive font-medium">{state.message}</p>
          {state.issues && (
            <ul className="mt-1 list-disc pl-5">
              {state.issues.map((i) => (
                <li key={`${i.path}:${i.message}`}>
                  {issueLabel(i.path)}: {i.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Section title="Offer">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="name" label="Offer name (required)">
            <Input
              id="name"
              value={d.name}
              onChange={(e) => set("name", e.target.value)}
              maxLength={200}
              required
            />
          </Field>
          <Field id="advertiserName" label="Advertiser">
            <Input
              id="advertiserName"
              list="advertiser-names"
              value={d.advertiserName}
              onChange={(e) => set("advertiserName", e.target.value)}
              maxLength={200}
              placeholder="unknown"
            />
            <datalist id="advertiser-names">
              {advertiserNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </Field>
          <Field id="vertical" label="Vertical">
            <Input
              id="vertical"
              value={d.vertical}
              onChange={(e) => set("vertical", e.target.value)}
              maxLength={100}
              placeholder="unknown"
            />
          </Field>
          <Field id="status" label="Status">
            <Select
              id="status"
              value={d.status}
              onChange={(v) => set("status", v as OfferDraft["status"])}
              options={OFFER_STATUSES}
              unknown={false}
            />
          </Field>
        </div>
      </Section>

      <Section title="Payout and targets" hint="Hidden from creatives (except payout model).">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="payoutModel" label="Payout model">
            <Select
              id="payoutModel"
              value={d.payoutModel}
              onChange={(v) => set("payoutModel", v)}
              options={PAYOUT_MODELS}
            />
          </Field>
          <Field id="targetCpl" label="Target CPL (USD)">
            <Input
              id="targetCpl"
              inputMode="decimal"
              value={d.targetCpl}
              onChange={(e) => set("targetCpl", e.target.value)}
              placeholder="unknown"
            />
          </Field>
          <Field id="targetRoi" label="Target ROI (%)">
            <Input
              id="targetRoi"
              inputMode="decimal"
              value={d.targetRoi}
              onChange={(e) => set("targetRoi", e.target.value)}
              placeholder="unknown"
            />
          </Field>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Payout tiers</span>
          {d.tiers.length === 0 && (
            <p className="text-muted-foreground text-xs">None entered (unknown).</p>
          )}
          {d.tiers.map((t, i) => (
            <div key={t.key ?? i} className="grid grid-cols-[1fr_8rem_1fr_auto] gap-2">
              <Input
                aria-label={`Tier ${i + 1} label`}
                placeholder="Label, e.g. base"
                value={t.label}
                onChange={(e) =>
                  set(
                    "tiers",
                    d.tiers.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                  )
                }
              />
              <Input
                aria-label={`Tier ${i + 1} amount (USD)`}
                placeholder="USD"
                inputMode="decimal"
                value={t.amount}
                onChange={(e) =>
                  set(
                    "tiers",
                    d.tiers.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                  )
                }
              />
              <Input
                aria-label={`Tier ${i + 1} condition`}
                placeholder="Condition, e.g. call > 90s"
                value={t.condition}
                onChange={(e) =>
                  set(
                    "tiers",
                    d.tiers.map((x, j) => (j === i ? { ...x, condition: e.target.value } : x)),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  set(
                    "tiers",
                    d.tiers.filter((_, j) => j !== i),
                  )
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() =>
              set("tiers", [
                ...d.tiers,
                { label: "", amount: "", condition: "", key: crypto.randomUUID() },
              ])
            }
          >
            Add tier
          </Button>
        </div>
      </Section>

      <Section title="States" hint="None selected = unknown. DC is included.">
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => set("states", [...US_STATES])}
          >
            All
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => set("states", [])}>
            Clear
          </Button>
          <span className="text-muted-foreground self-center text-xs">
            {d.states.length} selected
          </span>
        </div>
        <div className="grid grid-cols-6 gap-1 sm:grid-cols-9">
          {US_STATES.map((s) => (
            <label key={s} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={d.states.includes(s)}
                onChange={(e) =>
                  set(
                    "states",
                    e.target.checked ? [...d.states, s] : d.states.filter((x) => x !== s),
                  )
                }
              />
              {s}
            </label>
          ))}
        </div>
      </Section>

      <Section title="Cap and optimisation">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="capAmount" label="Cap amount">
            <Input
              id="capAmount"
              inputMode="numeric"
              value={d.capAmount}
              onChange={(e) => set("capAmount", e.target.value)}
              placeholder="unknown"
            />
          </Field>
          <Field id="capCounts" label="Cap counts">
            <Select
              id="capCounts"
              value={d.capCounts}
              onChange={(v) => set("capCounts", v)}
              options={CAP_COUNTS}
            />
          </Field>
          <Field id="capPeriod" label="Cap period">
            <Select
              id="capPeriod"
              value={d.capPeriod}
              onChange={(v) => set("capPeriod", v)}
              options={CAP_PERIODS}
            />
          </Field>
          <Field id="optimisationEvent" label="Optimisation event">
            <Input
              id="optimisationEvent"
              value={d.optimisationEvent}
              onChange={(e) => set("optimisationEvent", e.target.value)}
              placeholder="unknown"
              maxLength={200}
            />
          </Field>
          <Field id="feedbackDelayDays" label="Feedback delay (days)">
            <Input
              id="feedbackDelayDays"
              inputMode="numeric"
              value={d.feedbackDelayDays}
              onChange={(e) => set("feedbackDelayDays", e.target.value)}
              placeholder="unknown"
            />
          </Field>
          <Field id="approvalRequired" label="Network approval required?">
            <select
              id="approvalRequired"
              value={d.approvalRequired}
              onChange={(e) =>
                set("approvalRequired", e.target.value as OfferDraft["approvalRequired"])
              }
              className={control}
            >
              <option value="">unknown</option>
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          </Field>
        </div>
      </Section>

      <Section title="Call hours" hint="Times are in the offer's timezone.">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={d.callHoursKnown}
            onChange={(e) => set("callHoursKnown", e.target.checked)}
          />
          Call hours are known
        </label>
        {d.callHoursKnown && (
          <>
            <Field id="timezone" label="Timezone">
              <Select
                id="timezone"
                value={d.timezone}
                onChange={(v) => set("timezone", v)}
                options={US_TIMEZONES}
                unknown={false}
              />
            </Field>
            <p className="text-muted-foreground text-xs">A day with no hours is closed.</p>
            {WEEKDAYS.map((day) => (
              <div key={day} className="flex flex-wrap items-center gap-2">
                <span className="w-10 text-sm font-medium capitalize">{day}</span>
                {d.days[day].map((w, i) => (
                  <span key={w.key ?? i} className="flex items-center gap-1">
                    <Input
                      type="time"
                      aria-label={`${day} window ${i + 1} start`}
                      className="w-28"
                      value={w.start}
                      onChange={(e) =>
                        set("days", {
                          ...d.days,
                          [day]: d.days[day].map((x, j) =>
                            j === i ? { ...x, start: e.target.value } : x,
                          ),
                        })
                      }
                    />
                    –
                    <Input
                      type="time"
                      aria-label={`${day} window ${i + 1} end`}
                      className="w-28"
                      value={w.end}
                      onChange={(e) =>
                        set("days", {
                          ...d.days,
                          [day]: d.days[day].map((x, j) =>
                            j === i ? { ...x, end: e.target.value } : x,
                          ),
                        })
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        set("days", { ...d.days, [day]: d.days[day].filter((_, j) => j !== i) })
                      }
                    >
                      ✕
                    </Button>
                  </span>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() =>
                    set("days", {
                      ...d.days,
                      [day]: [
                        ...d.days[day],
                        { start: "09:00", end: "17:00", key: crypto.randomUUID() },
                      ],
                    })
                  }
                >
                  Add hours
                </Button>
              </div>
            ))}
          </>
        )}
      </Section>

      <Section title="Restrictions">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={d.restrictionsKnown}
            onChange={(e) => set("restrictionsKnown", e.target.checked)}
          />
          Restrictions are known (empty lists = confirmed none)
        </label>
        {d.restrictionsKnown && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="bannedClaims" label="Banned claims (one per line)">
              <textarea
                id="bannedClaims"
                rows={4}
                className={`${control} h-auto py-1`}
                value={d.bannedClaims}
                onChange={(e) => set("bannedClaims", e.target.value)}
              />
            </Field>
            <Field id="bannedWords" label="Banned words (one per line)">
              <textarea
                id="bannedWords"
                rows={4}
                className={`${control} h-auto py-1`}
                value={d.bannedWords}
                onChange={(e) => set("bannedWords", e.target.value)}
              />
            </Field>
            <Field id="restrictionNotes" label="Notes">
              <textarea
                id="restrictionNotes"
                rows={2}
                className={`${control} h-auto py-1`}
                value={d.restrictionNotes}
                onChange={(e) => set("restrictionNotes", e.target.value)}
              />
            </Field>
          </div>
        )}
      </Section>

      <Section
        title="URLs"
        hint="Versioned with the offer: changing them after approval needs a new draft."
      >
        {d.urls.map((u, i) => (
          <div key={u.key ?? i} className="grid grid-cols-[1fr_11rem_auto] gap-2">
            <Input
              aria-label={`URL ${i + 1}`}
              type="url"
              placeholder="https://"
              value={u.url}
              onChange={(e) =>
                set(
                  "urls",
                  d.urls.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                )
              }
            />
            <select
              aria-label={`URL ${i + 1} kind`}
              value={u.kind}
              onChange={(e) =>
                set(
                  "urls",
                  d.urls.map((x, j) =>
                    j === i ? { ...x, kind: e.target.value as typeof u.kind } : x,
                  ),
                )
              }
              className={control}
            >
              {OFFER_URL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                set(
                  "urls",
                  d.urls.filter((_, j) => j !== i),
                )
              }
            >
              Remove
            </Button>
            {u.kind === "offer_page" && (
              <label className="col-span-3 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={u.notTrackingLink}
                  onChange={(e) =>
                    set(
                      "urls",
                      d.urls.map((x, j) =>
                        j === i ? { ...x, notTrackingLink: e.target.checked } : x,
                      ),
                    )
                  }
                />
                URL {i + 1} is not a tracking link (a direct page, safe to fetch without registering
                a click)
              </label>
            )}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() =>
            set("urls", [
              ...d.urls,
              { url: "", kind: "offer_page", notTrackingLink: false, key: crypto.randomUUID() },
            ])
          }
        >
          Add URL
        </Button>
      </Section>

      <MissingChecklist missing={missing} />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <span className="text-muted-foreground text-xs">
          Saves a draft. A manager or admin approves it.
        </span>
      </div>
    </form>
  );
}

export function MissingChecklist({ missing }: { missing: string[] }) {
  if (!missing.length) {
    return (
      <p className="text-sm text-emerald-700 dark:text-emerald-400">
        All offer facts are filled in.
      </p>
    );
  }
  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
      data-testid="missing-fields"
    >
      <p className="font-medium">Still unknown ({missing.length})</p>
      <ul className="mt-1 list-disc pl-5">
        {missing.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}
