import React, { useEffect, useMemo, useState } from 'react'
import { Button, TextInput, InlineNotification } from '@carbon/react'

function computeTenantId() {
    // Priority:
    // 1) explicit ?tenant= in URL search
    // 2) ?tenant= in hash route (/#/concepts?tenant=foo)
    // 3) last selected tenant in localStorage (shared with AI Agent UI)
    try {
      const href = String(window.location.href || "");
      const u = new URL(href);
      const direct = u.searchParams.get("tenant");
      if (direct) return direct;

      const hash = String(u.hash || "");
      const qIdx = hash.indexOf("?");
      if (qIdx >= 0) {
        const qs = hash.slice(qIdx + 1);
        const hp = new URLSearchParams(qs);
        const hTenant = hp.get("tenant");
        if (hTenant) return hTenant;
      }

      try {
        const raw = window.localStorage.getItem("mx_settings_v5");
        if (raw) {
          const s = JSON.parse(raw);
          // AI Agent stores the tenant under settings.maximo.defaultTenant
          const lsTenant =
            s?.maximo?.defaultTenant ||
            s?.tenant ||
            s?.tenantId ||
            s?.selectedTenant ||
            s?.activeTenant;
          if (lsTenant) return String(lsTenant);
        }
      } catch { /* ignore */ }

      return "default";
    } catch {
      return "default";
    }
}

function useTenantFromUrl() {
  const [tenantId, setTenantId] = useState(() => computeTenantId())

  useEffect(() => {
    // Keep in sync with tenant changes made in the AI Agent (same-origin) by polling localStorage.
    // This also responds to URL changes (hash/query) without requiring a hard refresh.
    let last = tenantId
    const tick = () => {
      const cur = computeTenantId()
      if (cur && cur !== last) {
        last = cur
        setTenantId(cur)
      }
    }
    const id = window.setInterval(tick, 1000)
    const onHash = () => tick()
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', onHash)
    }
  }, [])

  return tenantId
}

function EditableTable({ title, rows, setRows, columns }) {
  const addRow = () => {
    const empty = {}
    for (const c of columns) empty[c.key] = ''
    setRows([...rows, empty])
  }
  const delRow = (idx) => {
    const next = rows.slice();
    next.splice(idx, 1)
    setRows(next)
  }
  const update = (idx, key, value) => {
    const next = rows.slice();
    next[idx] = { ...(next[idx] || {}), [key]: value }
    setRows(next)
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h4 style={{ margin: 0 }}>{title}</h4>
        <Button size="sm" kind="secondary" onClick={addRow}>Add</Button>
      </div>
      <div style={{ overflowX: 'auto', marginTop: 8, border: '1px solid var(--cds-border-subtle)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {columns.map(c => (
                <th key={c.key} style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--cds-border-subtle)' }}>{c.label}</th>
              ))}
              <th style={{ width: 1, borderBottom: '1px solid var(--cds-border-subtle)' }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={idx}>
                {columns.map(c => (
                  <td key={c.key} style={{ padding: 8, borderBottom: '1px solid var(--cds-border-subtle)' }}>
                    <TextInput
                      id={`${title}-${idx}-${c.key}`}
                      hideLabel
                      labelText={c.label}
                      size="sm"
                      value={String(r?.[c.key] ?? '')}
                      placeholder={c.placeholder || ''}
                      onChange={(e) => update(idx, c.key, e.target.value)}
                    />
                  </td>
                ))}
                <td style={{ padding: 8, borderBottom: '1px solid var(--cds-border-subtle)' }}>
                  <Button size="sm" kind="ghost" onClick={() => delRow(idx)}>Delete</Button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={columns.length + 1} style={{ padding: 12, opacity: 0.7 }}>
                  No entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function ConceptsPage({ tenant }) {
  const tenantIdFromUrl = useTenantFromUrl()
  const tenantId = String(tenant || tenantIdFromUrl || 'default')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [concepts, setConcepts] = useState(null)
  const [entities, setEntities] = useState([])
  const [statusPhrases, setStatusPhrases] = useState([])
  const [quickPhrases, setQuickPhrases] = useState([])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [cRes, oRes] = await Promise.all([
        fetch(`/mcp/concepts?tenant=${encodeURIComponent(tenantId)}`),
        fetch(`/api/concepts/overrides?tenant=${encodeURIComponent(tenantId)}`)
      ])
      if (!cRes.ok) throw new Error(`Failed to load concepts (${cRes.status})`)
      if (!oRes.ok) throw new Error(`Failed to load overrides (${oRes.status})`)
      const c = await cRes.json()
      const o = await oRes.json()
      setConcepts(c)
      const ov = o?.overrides || {}
      setEntities(Array.isArray(ov.entities) ? ov.entities : [])
      setStatusPhrases(Array.isArray(ov.statusPhrases) ? ov.statusPhrases : [])
      setQuickPhrases(Array.isArray(ov.quickPhrases) ? ov.quickPhrases : [])
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Reload concepts whenever the tenant changes (via ?tenant=, hash route, or AI Agent selection).
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const body = {
        entities: entities
          .map(e => ({
            label: String(e?.label || '').trim(),
            osCandidates: String(e?.osCandidates || '').split(',').map(s => s.trim()).filter(Boolean)
          }))
          .filter(e => e.label && e.osCandidates.length),
        statusPhrases: statusPhrases
          .map(s => ({ label: String(s?.label || '').trim(), text: String(s?.text || '').trim() }))
          .filter(s => s.label && s.text),
        quickPhrases: quickPhrases
          .map(q => ({ label: String(q?.label || '').trim(), text: String(q?.text || '').trim() }))
          .filter(q => q.label && q.text)
      }
      const r = await fetch(`/api/concepts/overrides?tenant=${encodeURIComponent(tenantId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!r.ok) throw new Error(`Save failed (${r.status})`)
      await load()
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Concept Catalog</h3>
          <div style={{ opacity: 0.7 }}>Tenant: <b>{tenantId}</b> (change via <code>?tenant=...</code>)</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" kind="secondary" onClick={load} disabled={loading || saving}>Refresh</Button>
          <Button size="sm" kind="primary" onClick={save} disabled={loading || saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 12 }}>
          <InlineNotification kind="error" title="Error" subtitle={error} lowContrast />
        </div>
      )}

      {loading ? (
        <div style={{ marginTop: 16, opacity: 0.7 }}>Loading…</div>
      ) : (
        <>
          <EditableTable
            title="Extra Entities"
            rows={entities}
            setRows={setEntities}
            columns={[
              { key: 'label', label: 'Label', placeholder: 'e.g. Job Plans' },
              { key: 'osCandidates', label: 'OS candidates (comma separated)', placeholder: 'e.g. mxapijobplan' }
            ]}
          />

          <EditableTable
            title="Extra Status Phrases"
            rows={statusPhrases}
            setRows={setStatusPhrases}
            columns={[
              { key: 'label', label: 'Label', placeholder: 'e.g. Approved' },
              { key: 'text', label: 'Phrase / token', placeholder: 'e.g. APPROVED' }
            ]}
          />

          <EditableTable
            title="Extra Quick Phrases"
            rows={quickPhrases}
            setRows={setQuickPhrases}
            columns={[
              { key: 'label', label: 'Label', placeholder: 'e.g. Top 10' },
              { key: 'text', label: 'Text', placeholder: 'e.g. show me the top 10 …' }
            ]}
          />

          <div style={{ marginTop: 20 }}>
            <h4 style={{ marginBottom: 8 }}>Merged catalog (read-only)</h4>
            <pre style={{ maxHeight: 520, overflow: 'auto', padding: 12, background: '#0b0f17', color: '#d4d4d4', borderRadius: 8 }}>{JSON.stringify(concepts, null, 2)}</pre>
          </div>
        </>
      )}
    </div>
  )
}
