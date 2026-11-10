import { useEffect, useState, type ReactNode } from 'react'

type StorageState = 'checking' | 'ready' | 'failed' | 'restarting'

/** Full application routes must remain inactive until the secure store opens. */
export function StoreRecoveryGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StorageState>('checking')
  const [errorMessage, setErrorMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    const dispose = window.electronAPI.store.onInitError(({ message }) => {
      if (!active) return
      if (message) {
        setErrorMessage('Secure local storage is unavailable. Existing data was preserved.')
        setState('failed')
      }
    })
    void window.electronAPI.config.get().then(() => {
      if (active) setState('ready')
    }).catch(() => {
      if (active) {
        setErrorMessage('Secure local storage is unavailable. Existing data was preserved.')
        setState('failed')
      }
    })
    return () => {
      active = false
      dispose()
    }
  }, [])

  async function retry() {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.electronAPI.store.retryInit()
      if (!result.success) {
        setErrorMessage('Unable to unlock secure local storage. Check your Windows account and try again.')
        setState('failed')
        return
      }
      setState('restarting')
    } catch {
      setErrorMessage('Unable to retry secure storage initialization.')
      setState('failed')
    } finally {
      setBusy(false)
    }
  }

  if (state === 'ready') return <>{children}</>

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg rounded-xl border bg-card p-8 shadow-sm space-y-5">
        <h1 className="text-2xl font-semibold">Chat2API Private Local</h1>
        {state === 'checking' ? (
          <p className="text-muted-foreground">Checking secure local storage…</p>
        ) : state === 'restarting' ? (
          <p className="text-muted-foreground">Secure storage is ready. Restarting the application…</p>
        ) : (
          <>
            <p role="alert" className="text-muted-foreground">{errorMessage}</p>
            <p className="text-sm">No account records were reset or deleted.</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => { void retry() }}
              className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
            >
              {busy ? 'Checking…' : 'Retry secure storage'}
            </button>
          </>
        )}
      </div>
    </main>
  )
}
