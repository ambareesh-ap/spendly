import { useState, useRef, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'
import './App.css'

// ── Categories ─────────────────────────────────────────────────────────────────
// defaultBudget = monthly CAD target (0 = no meaningful budget for that category)

const CATEGORIES = [
  { name: 'Rent',                  emoji: '🏠',  defaultBudget: 2700 },
  { name: 'Internet',              emoji: '🌐',  defaultBudget: 75   },
  { name: 'Phone Bill',            emoji: '📱',  defaultBudget: 75   },
  { name: 'Electricity',           emoji: '⚡',  defaultBudget: 75   },
  { name: 'Groceries',             emoji: '🛒',  defaultBudget: 500  },
  { name: 'Self-care/Hygiene',     emoji: '🧴',  defaultBudget: 300  },
  { name: 'Travel',                emoji: '✈️',  defaultBudget: 1000 },
  { name: 'Transportation',        emoji: '🚌',  defaultBudget: 250  },
  { name: 'Furniture/Cookware',    emoji: '🪑',  defaultBudget: 300  },
  { name: 'Clothing/Footwear',     emoji: '👟',  defaultBudget: 200  },
  { name: 'Electronics',           emoji: '💻',  defaultBudget: 300  },
  { name: 'Restaurants',           emoji: '🍽️',  defaultBudget: 300  },
  { name: 'Entertainment',         emoji: '🎬',  defaultBudget: 200  },
  { name: 'Dog Care & Food',       emoji: '🐕',  defaultBudget: 250  },
  { name: 'Dog Toys',              emoji: '🦴',  defaultBudget: 75   },
  { name: 'Credit Card Fees',      emoji: '💳',  defaultBudget: 15   },
  { name: 'Gym/Classes Membership',emoji: '🏋️',  defaultBudget: 75   },
  { name: 'TFSA',                  emoji: '💰',  defaultBudget: 1166 },
  { name: 'RRSP',                  emoji: '🏦',  defaultBudget: 3000 },
  { name: 'Money to India',        emoji: '🇮🇳',  defaultBudget: 3000 },
  { name: 'Domains/Cloud',         emoji: '☁️',  defaultBudget: 50   },
  { name: 'Gifts',                 emoji: '🎁',  defaultBudget: 500  },
  { name: 'Miscellaneous',         emoji: '📦',  defaultBudget: 0    },
  { name: 'FHSA',                  emoji: '🏡',  defaultBudget: 667  },
  { name: 'Refunds',               emoji: '↩️',  defaultBudget: 0    },
]

const CATEGORY_EMOJI = Object.fromEntries(CATEGORIES.map(c => [c.name, c.emoji]))
const CATEGORY_NAMES = CATEGORIES.map(c => c.name).join(', ')

function buildSystemPrompt(today) {
  return `You are an expense parsing assistant for a Canadian user. Today's date is ${today}. You respond ONLY with one of two valid JSON shapes — nothing else.

SHAPE 1 — confident, log it:
{"ready": true, "amount": <number>, "merchant": "<string>", "category": "<category>", "notes": <string|null>, "original_amount": <number|null>, "original_currency": "<ISO 4217 code|null>", "date": "<YYYY-MM-DD>"}

SHAPE 2 — genuinely ambiguous, ask one clarifying question:
{"ready": false, "question": "<one short question>", "partial": {"amount": <number|null>, "merchant": "<string|null>"}}

Allowed categories: ${CATEGORY_NAMES}

Shape 1 field rules:
- amount: the numeric value the user mentioned, always positive, no currency symbols
- merchant: the store, service, or payee name, properly capitalized
- category: must be exactly one of the allowed values above
- notes: any specific contextual detail — dish name, location, person, occasion, purpose. null if nothing notable
- original_currency: ISO 4217 code if the user mentions a non-CAD currency (e.g. "AED", "EUR", "INR", "USD"). null if CAD or unspecified
- original_amount: same value as amount when original_currency is not null, otherwise null
- date: the expense date in YYYY-MM-DD format. Infer from today (${today}) using these rules:
  • Any explicit date or day name ("June 15", "on Tuesday", "the 3rd") → infer exactly, set ready: true
  • "yesterday" → 1 day before today
  • "last week" or "this past week" → 7 days before today (same weekday)
  • "this week" → today
  • "last month" → first day of the previous calendar month
  • "this month" → today
  • "last year" → same month and day, one year ago
  • "a few days ago" → 3 days before today
  • "recently", "the other day", "a while ago", "earlier" → today
  • ANY other relative time reference → make a reasonable inference and set ready: true
  • If the user gives ZERO time context of any kind (no day, no week, no month, no relative phrase) AND amount is $50 or under → today, silently, ready: true
  • If the user gives ZERO time context of any kind AND amount is over $50 → use Shape 2 to ask "Was this today, or a different date?" — but only after category is resolved; ask category first if that's also unclear

When to use Shape 2 (ask one question):
- Category is genuinely ambiguous between two very different buckets (e.g. Electronics vs Entertainment for a gaming purchase) — ask category first
- No date mentioned and amount > $50, and category is already resolved — ask date
- The message is so vague you cannot extract a merchant or amount at all

When NOT to use Shape 2 (just log it with Shape 1):
- Obvious merchant → category pairs: Tim Hortons → Restaurants, Uber → Transportation, Netflix → Entertainment
- Savings/investment contributions: TFSA, RRSP, FHSA, Money to India → use those category names directly
- Any purchase $50 or under — pick the most likely category and default date to today
- When the conversation history already resolved the ambiguity

STRICT OUTPUT FORMAT:
- Start your response with { and end with }
- Never include any explanation, apology, or text outside the JSON
- Never start your response with the word I
- If you cannot identify any expense at all, use Shape 2 with a question like "What did you spend money on?"`
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

function formatMonth(yyyyMM) {
  const [y, m] = yyyyMM.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric',
  })
}

// ── Chat sub-components ────────────────────────────────────────────────────────

function ExpenseCard({ expense }) {
  const hasConversion = expense.original_currency && expense.original_currency !== 'CAD'
  return (
    <div className="expense-card">
      <div className="expense-card-icon">{CATEGORY_EMOJI[expense.category] ?? '📦'}</div>
      <div className="expense-card-details">
        <div className="expense-card-amount">${Number(expense.amount).toFixed(2)}</div>
        {hasConversion && (
          <div className="expense-card-conversion">
            converted from {Number(expense.original_amount).toLocaleString()} {expense.original_currency}
          </div>
        )}
        <div className="expense-card-merchant">{expense.merchant}</div>
        <span className="category-pill">{expense.category}</span>
      </div>
    </div>
  )
}

function Message({ message }) {
  const isUser = message.role === 'user'
  return (
    <div className={`message ${isUser ? 'message-user' : 'message-assistant'}`}>
      {!isUser && <div className="message-avatar">S</div>}
      <div className="message-content">
        <div className="message-bubble">{message.text}</div>
        {message.expense && <ExpenseCard expense={message.expense} />}
      </div>
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="message message-assistant">
      <div className="message-avatar">S</div>
      <div className="message-content">
        <div className="message-bubble typing">
          <span /><span /><span />
        </div>
      </div>
    </div>
  )
}

// ── Log view ───────────────────────────────────────────────────────────────────

function LogView({ expenses, loading, onDelete }) {
  if (loading) return <div className="empty-state">Loading…</div>
  if (!expenses.length) {
    return <div className="empty-state">No expenses yet. Head to Chat to log one.</div>
  }
  return (
    <div className="log-view">
      {expenses.map(exp => (
        <div key={exp.id} className="log-row">
          <div className="log-row-icon">{CATEGORY_EMOJI[exp.category] ?? '📦'}</div>
          <div className="log-row-info">
            <div className="log-row-merchant">{exp.merchant}</div>
            {exp.notes && <div className="log-row-notes">{exp.notes}</div>}
            <span className="category-pill">{exp.category}</span>
          </div>
          <div className="log-row-meta">
            <div className="log-row-amount">${Number(exp.amount).toFixed(2)}</div>
            <div className="log-row-date">{formatDate(exp.date)}</div>
          </div>
          <button className="delete-btn" onClick={() => onDelete(exp.id)} title="Delete">×</button>
        </div>
      ))}
    </div>
  )
}

// ── Summary view (current month only) ─────────────────────────────────────────

function SummaryView({ expenses, budgetMap }) {
  const currentMonth = new Date().toISOString().slice(0, 7)
  const monthExpenses = expenses.filter(e => e.date.slice(0, 7) === currentMonth)

  const byCategory = {}
  for (const exp of monthExpenses) {
    byCategory[exp.category] = (byCategory[exp.category] ?? 0) + Number(exp.amount)
  }
  const sorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1])
  const totalSpent = sorted.reduce((sum, [, amt]) => sum + amt, 0)
  const totalBudgeted = Object.values(budgetMap).reduce((sum, { amount }) => sum + amount, 0)
  const hasBudgets = totalBudgeted > 0
  const remaining = totalBudgeted - totalSpent

  return (
    <div className="summary-view">
      <div className="summary-header">
        <h2 className="summary-current-month">{formatMonth(currentMonth)}</h2>
        <div className="summary-totals">
          <div className="summary-total-item">
            <span className="summary-total-label">Spent</span>
            <span className="summary-total-value">${totalSpent.toFixed(2)}</span>
          </div>
          {hasBudgets && (
            <>
              <div className="summary-totals-sep" />
              <div className="summary-total-item">
                <span className="summary-total-label">Budgeted</span>
                <span className="summary-total-value">${totalBudgeted.toFixed(2)}</span>
              </div>
              <div className="summary-totals-sep" />
              <div className="summary-total-item">
                <span className="summary-total-label">{remaining >= 0 ? 'Remaining' : 'Over'}</span>
                <span className={`summary-total-value ${remaining >= 0 ? 'summary-remaining' : 'summary-over'}`}>
                  ${Math.abs(remaining).toFixed(2)}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="empty-state" style={{ flex: 'none', padding: '32px 0 0' }}>
          No expenses logged this month yet.
        </div>
      ) : (
        <table className="summary-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Spent</th>
              {hasBudgets && <th>Budget</th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map(([cat, amt]) => {
              const catBudget = budgetMap[cat]?.amount
              return (
                <tr key={cat}>
                  <td><span className="cat-emoji">{CATEGORY_EMOJI[cat] ?? '📦'}</span>{cat}</td>
                  <td>${amt.toFixed(2)}</td>
                  {hasBudgets && <td>{catBudget ? `$${catBudget.toFixed(0)}` : '—'}</td>}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td>${totalSpent.toFixed(2)}</td>
              {hasBudgets && <td>${totalBudgeted.toFixed(0)}</td>}
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}

// ── Archive view (past months) ─────────────────────────────────────────────────

function ArchiveView({ expenses }) {
  const currentMonth = new Date().toISOString().slice(0, 7)
  const past = expenses.filter(e => e.date.slice(0, 7) < currentMonth)

  if (!past.length) {
    return <div className="empty-state">Past months will appear here automatically.</div>
  }

  const byMonth = {}
  for (const exp of past) {
    const month = exp.date.slice(0, 7)
    if (!byMonth[month]) byMonth[month] = {}
    byMonth[month][exp.category] = (byMonth[month][exp.category] ?? 0) + Number(exp.amount)
  }
  const months = Object.keys(byMonth).sort((a, b) => b.localeCompare(a))

  return (
    <div className="summary-view">
      {months.map(month => {
        const cats = byMonth[month]
        const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1])
        const total = sorted.reduce((sum, [, amt]) => sum + amt, 0)
        return (
          <div key={month} className="summary-month">
            <h2 className="summary-month-title">{formatMonth(month)}</h2>
            <table className="summary-table">
              <thead>
                <tr><th>Category</th><th>Total</th></tr>
              </thead>
              <tbody>
                {sorted.map(([cat, amt]) => (
                  <tr key={cat}>
                    <td><span className="cat-emoji">{CATEGORY_EMOJI[cat] ?? '📦'}</span>{cat}</td>
                    <td>${amt.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td>Total</td><td>${total.toFixed(2)}</td></tr>
              </tfoot>
            </table>
          </div>
        )
      })}
    </div>
  )
}

// ── Budgets view ───────────────────────────────────────────────────────────────

function BudgetView({ budgetMap, onSave }) {
  // Pre-fill inputs with defaultBudget; Supabase values override on load
  const [inputs, setInputs] = useState(() =>
    Object.fromEntries(
      CATEGORIES.map(c => [c.name, c.defaultBudget > 0 ? String(c.defaultBudget) : ''])
    )
  )
  const [saving, setSaving] = useState(new Set())
  const [saved, setSaved] = useState(new Set())

  useEffect(() => {
    setInputs(prev => {
      const next = { ...prev }
      for (const [cat, { amount }] of Object.entries(budgetMap)) {
        next[cat] = String(amount)
      }
      return next
    })
  }, [budgetMap])

  const handleSave = async (name) => {
    const amount = parseFloat(inputs[name])
    if (!amount || amount <= 0) return
    setSaving(prev => new Set(prev).add(name))
    await onSave(name, amount)
    setSaving(prev => { const s = new Set(prev); s.delete(name); return s })
    setSaved(prev => new Set(prev).add(name))
    setTimeout(() => setSaved(prev => { const s = new Set(prev); s.delete(name); return s }), 2000)
  }

  return (
    <div className="budgets-view">
      <p className="budgets-subtitle">Set a monthly spending limit for each category.</p>
      {CATEGORIES.map(({ name, emoji }) => (
        <div key={name} className="budget-row">
          <div className="budget-row-label">
            <span className="budget-row-emoji">{emoji}</span>
            <span className="budget-row-name">{name}</span>
          </div>
          <div className="budget-row-right">
            <div className="budget-input-wrap">
              <span className="budget-input-prefix">$</span>
              <input
                className="budget-input"
                type="number"
                min="0"
                step="1"
                placeholder="—"
                value={inputs[name]}
                onChange={e => setInputs(prev => ({ ...prev, [name]: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && handleSave(name)}
              />
            </div>
            <button
              className={`budget-save-btn${saved.has(name) ? ' budget-save-btn--saved' : ''}`}
              onClick={() => handleSave(name)}
              disabled={saving.has(name)}
            >
              {saved.has(name) ? 'Saved ✓' : saving.has(name) ? '…' : 'Save'}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── App ────────────────────────────────────────────────────────────────────────

const TABS = ['chat', 'log', 'summary', 'archive', 'budgets']

export default function App() {
  const [tab, setTab] = useState('chat')
  const [messages, setMessages] = useState([
    {
      id: 1,
      role: 'assistant',
      text: "Hi! Tell me about an expense and I'll log it for you. Try something like \"paid rent $2700\" or \"spent 500 dirhams on groceries\".",
    },
  ])
  const [expenses, setExpenses] = useState([])
  const [expensesLoading, setExpensesLoading] = useState(false)
  const [budgetMap, setBudgetMap] = useState({})
  // pendingExpense holds the conversation thread when Claude asks a clarifying question
  // { thread: Array<{role, content}> } — appended each turn until ready: true
  const [pendingExpense, setPendingExpense] = useState(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)

  const fetchExpenses = useCallback(async () => {
    setExpensesLoading(true)
    const { data, error } = await supabase
      .from('expenses')
      .select('*')
      .order('date', { ascending: false })
      .order('id', { ascending: false })
    const rows = error ? [] : (data ?? [])
    if (!error) setExpenses(rows)
    setExpensesLoading(false)
    return rows
  }, [])

  const fetchBudgets = useCallback(async () => {
    const { data, error } = await supabase.from('budgets').select('*')
    if (!error && data) {
      setBudgetMap(
        Object.fromEntries(data.map(row => [row.category, { id: row.id, amount: Number(row.amount) }]))
      )
    }
  }, [])

  useEffect(() => {
    fetchExpenses()
    fetchBudgets()
  }, [fetchExpenses, fetchBudgets])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const handleDelete = async (id) => {
    await supabase.from('expenses').delete().eq('id', id)
    fetchExpenses()
  }

  const saveBudget = async (category, amount) => {
    const existing = budgetMap[category]
    if (existing?.id) {
      await supabase.from('budgets').update({ amount }).eq('id', existing.id)
    } else {
      await supabase.from('budgets').insert({ category, amount })
    }
    await fetchBudgets()
  }

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading) return

    setMessages(prev => [...prev, { id: Date.now(), role: 'user', text }])
    setInput('')
    setLoading(true)

    try {
      const today = new Date().toISOString().split('T')[0]

      // ── Step 1: build message history ─────────────────────────────────────
      // If we're in a clarification loop, prepend the existing thread so Claude
      // has full context. apiMessages ends with the current user turn.
      const apiMessages = pendingExpense
        ? [...pendingExpense.thread, { role: 'user', content: text }]
        : [{ role: 'user', content: text }]

      // ── Step 2: call Claude ────────────────────────────────────────────────
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': import.meta.env.VITE_ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 300,
          system: buildSystemPrompt(today),
          messages: apiMessages,
        }),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.error?.message ?? `API error ${response.status}`)
      }

      const data = await response.json()
      const rawText = data.content[0].text.trim()

      if (!rawText.startsWith('{')) {
        setMessages(prev => [...prev, {
          id: Date.now(), role: 'assistant',
          text: "I couldn't understand that as an expense. Try something like \"paid rent $2700\" or \"spent $15 at Tim Hortons\".",
        }])
        return
      }

      let parsed
      try {
        parsed = JSON.parse(rawText)
      } catch {
        setMessages(prev => [...prev, {
          id: Date.now(), role: 'assistant',
          text: "Got an unexpected response — please try rephrasing your expense.",
        }])
        return
      }

      // ── Step 3: clarification needed — ask and wait ────────────────────────
      if (!parsed.ready) {
        setMessages(prev => [...prev, {
          id: Date.now(), role: 'assistant', text: parsed.question,
        }])
        // Extend the thread with this turn so the next reply has full context
        setPendingExpense({ thread: [...apiMessages, { role: 'assistant', content: rawText }] })
        return
      }

      // ── Step 4: ready — clear pending, extract fields ──────────────────────
      setPendingExpense(null)

      const { amount, merchant, category, notes, original_amount, original_currency, date } = parsed

      // ── Step 5: currency conversion if needed ──────────────────────────────
      let finalAmount = amount
      const needsConversion = original_currency && original_currency !== 'CAD'

      if (needsConversion) {
        const rateRes = await fetch('https://open.er-api.com/v6/latest/CAD')
        if (!rateRes.ok) throw new Error('Could not fetch exchange rates')
        const rateData = await rateRes.json()
        const rate = rateData.rates[original_currency]
        if (!rate) throw new Error(`Unknown currency code: ${original_currency}`)
        finalAmount = original_amount / rate
      }

      // ── Step 6: save to Supabase ───────────────────────────────────────────
      const { error: dbError } = await supabase.from('expenses').insert({
        amount: finalAmount,
        merchant,
        category,
        date: date ?? today,
        notes: notes ?? null,
        original_amount: needsConversion ? original_amount : null,
        original_currency: needsConversion ? original_currency : null,
      })

      if (dbError) throw new Error(dbError.message)

      // ── Step 7: budget warning ─────────────────────────────────────────────
      const freshExpenses = await fetchExpenses()
      const currentMonth = new Date().toISOString().slice(0, 7)
      const monthTotal = freshExpenses
        .filter(e => e.category === category && e.date.slice(0, 7) === currentMonth)
        .reduce((sum, e) => sum + Number(e.amount), 0)

      const budget = budgetMap[category]
      let warningText = null
      if (budget) {
        const pct = (monthTotal / budget.amount) * 100
        if (pct > 100) {
          const over = (monthTotal - budget.amount).toFixed(2)
          warningText = `🚨 Over budget! You've exceeded your ${category} limit by $${over}`
        } else if (pct >= 75) {
          warningText = `⚠️ Heads up! You've used ${Math.round(pct)}% of your ${category} budget this month`
        }
      }

      setMessages(prev => {
        const next = [
          ...prev,
          {
            id: Date.now(),
            role: 'assistant',
            text: "Got it! I've logged your expense:",
            expense: {
              amount: finalAmount,
              merchant,
              category,
              original_amount: needsConversion ? original_amount : null,
              original_currency: needsConversion ? original_currency : null,
            },
          },
        ]
        if (warningText) next.push({ id: Date.now() + 1, role: 'assistant', text: warningText })
        return next
      })
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { id: Date.now(), role: 'assistant', text: `Something went wrong: ${err.message}` },
      ])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <span className="header-logo">💸</span>
          <h1 className="header-title">Spendly</h1>
        </div>
        <nav className="tabs">
          {TABS.map(t => (
            <button
              key={t}
              className={`tab ${tab === t ? 'tab-active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>

      {/* Chat stays mounted so the conversation is preserved when switching tabs */}
      <div className="chat-container" style={{ display: tab === 'chat' ? 'flex' : 'none' }}>
        <div className="message-list">
          {messages.map(msg => (
            <Message key={msg.id} message={msg} />
          ))}
          {loading && <TypingIndicator />}
          <div ref={bottomRef} />
        </div>
        <div className="input-bar">
          <input
            className="input-field"
            type="text"
            placeholder='e.g. paid rent $2700 or spent 500 dirhams on groceries'
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
          <button
            className="send-button"
            onClick={sendMessage}
            disabled={loading || !input.trim()}
          >
            Send
          </button>
        </div>
      </div>

      {tab === 'log'     && <LogView expenses={expenses} loading={expensesLoading} onDelete={handleDelete} />}
      {tab === 'summary' && <SummaryView expenses={expenses} budgetMap={budgetMap} />}
      {tab === 'archive' && <ArchiveView expenses={expenses} />}
      {tab === 'budgets' && <BudgetView budgetMap={budgetMap} onSave={saveBudget} />}
    </div>
  )
}
