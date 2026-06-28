import { useState, useRef, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'
import './App.css'

const CATEGORIES = [
  { name: 'Food & Drink',      emoji: '🍔' },
  { name: 'Transport',         emoji: '🚗' },
  { name: 'Health',            emoji: '💊' },
  { name: 'Shopping',          emoji: '🛍️' },
  { name: 'Entertainment',     emoji: '🎬' },
  { name: 'Bills & Utilities', emoji: '🏠' },
  { name: 'Other',             emoji: '📦' },
]
const CATEGORY_EMOJI = Object.fromEntries(CATEGORIES.map(c => [c.name, c.emoji]))

const SYSTEM_PROMPT = `You are an expense parsing assistant. Extract expense details from the user's message and respond ONLY with a valid JSON object in this exact format:
{"amount": <number>, "merchant": "<string>", "category": "<category>"}

Allowed categories: Food & Drink, Transport, Health, Shopping, Entertainment, Bills & Utilities, Other

Rules:
- amount must be a positive number with no currency symbols
- merchant is the store or service name, properly capitalized
- category must be exactly one of the allowed values
- If you cannot identify a clear expense, respond with: {"error": "I couldn't find an expense in that message. Try something like 'spent $12 on coffee at Starbucks'."}`

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
  return (
    <div className="expense-card">
      <div className="expense-card-icon">{CATEGORY_EMOJI[expense.category] ?? '📦'}</div>
      <div className="expense-card-details">
        <div className="expense-card-amount">${Number(expense.amount).toFixed(2)}</div>
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

// ── Summary view ───────────────────────────────────────────────────────────────

function SummaryView({ expenses }) {
  if (!expenses.length) {
    return <div className="empty-state">No expenses yet. Head to Chat to log one.</div>
  }

  const byMonth = {}
  for (const exp of expenses) {
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
  const [inputs, setInputs] = useState(() =>
    Object.fromEntries(CATEGORIES.map(c => [c.name, '']))
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

const TABS = ['chat', 'log', 'summary', 'budgets']

export default function App() {
  const [tab, setTab] = useState('chat')
  const [messages, setMessages] = useState([
    {
      id: 1,
      role: 'assistant',
      text: "Hi! Tell me about an expense and I'll log it for you. Try something like \"spent $12 on coffee at Starbucks\".",
    },
  ])
  const [expenses, setExpenses] = useState([])
  const [expensesLoading, setExpensesLoading] = useState(false)
  // { [category]: { id, amount } }
  const [budgetMap, setBudgetMap] = useState({})
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)

  // Returns the fresh rows so sendMessage can use them without waiting for React state
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
          max_tokens: 256,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: text }],
        }),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err?.error?.message ?? `API error ${response.status}`)
      }

      const data = await response.json()
      const parsed = JSON.parse(data.content[0].text)

      if (parsed.error) {
        setMessages(prev => [...prev, { id: Date.now(), role: 'assistant', text: parsed.error }])
        return
      }

      const { amount, merchant, category } = parsed

      const { error: dbError } = await supabase.from('expenses').insert({
        amount,
        merchant,
        category,
        date: new Date().toISOString().split('T')[0],
      })

      if (dbError) throw new Error(dbError.message)

      // Use the returned fresh data — React state won't have updated yet
      const freshExpenses = await fetchExpenses()

      // Budget warning: sum this category's spend for the current calendar month
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
            expense: { amount, merchant, category },
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
            placeholder='e.g. spent $12 on coffee at Starbucks'
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
      {tab === 'summary' && <SummaryView expenses={expenses} />}
      {tab === 'budgets' && <BudgetView budgetMap={budgetMap} onSave={saveBudget} />}
    </div>
  )
}
