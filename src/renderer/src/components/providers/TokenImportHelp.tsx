import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Bookmark, Check, Copy, ExternalLink } from 'lucide-react'

/** Mirrors TokenExtractionGuide in src/main/oauth/guides (kept local so the
 *  renderer bundle does not reach into the main process). */
export interface TokenImportGuide {
  loginUrl: string
  steps: string[]
  tokenKey: string
  /** Form field the pasted value belongs in, when it differs from tokenKey. */
  credentialField?: string
  tokenLabel: string
  storageType: 'localStorage' | 'cookie' | 'other'
  placeholder?: string
  helpUrl?: string
}

interface TokenImportHelpProps {
  guide: TokenImportGuide
  /** `javascript:` URL for the provider's token-copy helper. */
  bookmarklet: string | null
  /** Opens the provider site in a new tab (or the OS browser). */
  onOpenSite: () => void
}

/**
 * The web build cannot scrape a provider tab (different origin, different
 * cookie jar), so the user logs in normally in their own browser and this panel
 * hands them a bookmarklet that copies the token out of that page. Everything
 * here is phone-first: no DevTools, no F12, no extensions.
 */
export function TokenImportHelp({ guide, bookmarklet, onOpenSite }: TokenImportHelpProps) {
  const [copiedFull, setCopiedFull] = useState(false)
  const [copiedBody, setCopiedBody] = useState(false)

  const host = new URL(guide.loginUrl).hostname
  // Chrome strips a leading `javascript:` from pasted text (both omnibox and
  // the bookmark URL field), which silently turns the bookmarklet into a search
  // query. Offering the body without the scheme lets the user type the prefix
  // by hand first — the paste then does not start with `javascript:` and is
  // left alone.
  const scriptBody = bookmarklet ? bookmarklet.replace(/^javascript:/i, '') : null

  const copy = async (text: string, mark: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text)
      mark(true)
      setTimeout(() => mark(false), 2000)
    } catch {
      // Clipboard can be blocked on insecure origins; the code stays visible
      // in the <code> block below so it can still be selected by hand.
    }
  }

  return (
    <div
      data-testid="web-login-guide"
      className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
    >
      <p className="mb-2 font-medium">
        Login on the provider's site, then import the {guide.tokenLabel}.
      </p>
      <ol className="mb-3 list-decimal space-y-1 pl-5 text-muted-foreground">
        {guide.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={onOpenSite}>
          <ExternalLink className="mr-1 h-3.5 w-3.5" />
          Open {host}
        </Button>

        {bookmarklet && (
          <>
            <a
              href={bookmarklet}
              draggable
              onClick={(e) => e.preventDefault()}
              className="inline-flex cursor-move items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
              title="Drag to a bookmarks bar (desktop). On a phone use the copy buttons below."
            >
              <Bookmark className="mr-1 h-3.5 w-3.5" />
              Copy {guide.tokenLabel} (bookmarklet)
            </a>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="copy-bookmarklet"
              onClick={() => bookmarklet && copy(bookmarklet, setCopiedFull)}
            >
              {copiedFull ? (
                <>
                  <Check className="mr-1 h-3.5 w-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="mr-1 h-3.5 w-3.5" />
                  Copy code
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="copy-script-body"
              onClick={() => scriptBody && copy(scriptBody, setCopiedBody)}
            >
              {copiedBody ? (
                <>
                  <Check className="mr-1 h-3.5 w-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="mr-1 h-3.5 w-3.5" />
                  Copy without “javascript:”
                </>
              )}
            </Button>
          </>
        )}
      </div>

      {bookmarklet && (
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">How to run it on a phone</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Tap <strong>Copy without “javascript:”</strong> above.
            </li>
            <li>
              In this browser, bookmark any page (menu → star) — we only need the
              bookmark entry as a container.
            </li>
            <li>
              Open the bookmarks list, long-press that bookmark → <strong>Edit</strong>, then
              clear its URL field.
            </li>
            <li>
              Type <code className="rounded bg-muted px-1">java</code> by hand first, then
              paste — the field becomes{' '}
              <code className="rounded bg-muted px-1">javascript:(function…</code>. Save.
            </li>
            <li>
              Go back to <strong>{host}</strong> while still logged in, tap the address bar,
              type the bookmark's name, and tap the suggestion carrying the{' '}
              <strong>star icon</strong> (not a search result). The script runs against that
              page and copies the {guide.tokenLabel}.
            </li>
            <li>
              Return here, paste into the{' '}
              <code className="rounded bg-muted px-1">{guide.tokenKey}</code> field.
            </li>
          </ol>
          <p className="pt-1">
            Why the hand-typed prefix: Chrome deletes a leading{' '}
            <code className="rounded bg-muted px-1">javascript:</code> from anything you
            paste, so the bookmark would otherwise become a search for your code.
          </p>
        </div>
      )}

      <span className="mt-2 block text-xs text-muted-foreground">
        Field:{' '}
        <code className="rounded bg-muted px-1">{guide.credentialField ?? guide.tokenKey}</code>
        {guide.credentialField && guide.credentialField !== guide.tokenKey && (
          <span className="ml-2">
            (read from <code className="rounded bg-muted px-1">{guide.tokenKey}</code>)
          </span>
        )}
      </span>
    </div>
  )
}
