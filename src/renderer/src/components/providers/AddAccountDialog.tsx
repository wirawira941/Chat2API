/**
 * Add Account Dialog Component
 * Supports OAuth login and manual input methods
 */

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { 
  ExternalLink, 
  User, 
  AlertCircle,
  Loader2,
  CheckCircle2,
  Eye,
  EyeOff,
  Copy,
  Check,
  Bookmark
} from 'lucide-react'
import type { Provider, CredentialField, Account, BuiltinProviderConfig, ProviderVendor } from '@/types/electron'

/**
 * Map OAuth credentials to provider credential field names
 * OAuth returns credentials with keys like 'chatglm_refresh_token', but providers expect 'refresh_token'
 * DeepSeek stores token as JSON: {"value":"..."}
 */
function mapOAuthCredentials(providerId: string | undefined, credentials: Record<string, string>): Record<string, string> {
  if (!providerId) return credentials

  const credentialKeyMap: Record<string, string> = {
    'glm': 'chatglm_refresh_token',
    'deepseek': 'userToken',
    'qwen': 'tongyi_sso_ticket',
    'qwen-ai': 'tongyi_sso_ticket',
    'zai': 'tongyi_sso_ticket',
    'perplexity': '__Secure-next-auth.session-token',
    'mimo': 'serviceToken',
  }

  const providerFieldNames: Record<string, string> = {
    'glm': 'refresh_token',
    'deepseek': 'token',
    'qwen': 'ticket',
    'qwen-ai': 'ticket',
    'zai': 'ticket',
    'perplexity': 'sessionToken',
    'mimo': 'service_token',
  }

  const oauthKey = credentialKeyMap[providerId]
  if (oauthKey && credentials[oauthKey]) {
    const fieldName = providerFieldNames[providerId]
    if (fieldName) {
      // Handle JSON-wrapped tokens (DeepSeek stores token as {"value":"..."})
      let tokenValue = credentials[oauthKey]
      if (providerId === 'deepseek' && tokenValue && tokenValue.startsWith('{') && tokenValue.endsWith('}')) {
        try {
          const parsed = JSON.parse(tokenValue)
          if (parsed.value) {
            tokenValue = parsed.value
          }
        } catch (e) {
          console.error('[AddAccountDialog] Error parsing JSON token:', e)
        }
      }
      return { [fieldName]: tokenValue }
    }
  }

  // For Perplexity, if we have the secure token, map it
  if (providerId === 'perplexity' && credentials['__Secure-next-auth.session-token']) {
    return { sessionToken: credentials['__Secure-next-auth.session-token'] }
  }
  if (providerId === 'perplexity' && credentials['next-auth.session-token']) {
    return { sessionToken: credentials['next-auth.session-token'] }
  }

  // For Mimo, map all three tokens
  if (providerId === 'mimo') {
    const result: Record<string, string> = {}
    // OAuth already returns credentials in correct format (service_token, user_id, ph_token)
    // Check for final format first
    if (credentials['service_token']) {
      result['service_token'] = credentials['service_token']
    } else if (credentials['serviceToken']) {
      result['service_token'] = credentials['serviceToken']
    }
    if (credentials['user_id']) {
      result['user_id'] = credentials['user_id']
    } else if (credentials['userId']) {
      result['user_id'] = credentials['userId']
    }
    if (credentials['ph_token']) {
      result['ph_token'] = credentials['ph_token']
    } else if (credentials['xiaomichatbot_ph']) {
      result['ph_token'] = credentials['xiaomichatbot_ph']
    }
    return result
  }

  return credentials
}

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: Provider | null
  onAddAccount: (data: {
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }) => Promise<void>
  onValidateToken: (providerId: string, credentials: Record<string, string>) => Promise<{
    valid: boolean
    error?: string
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>
  editingAccount?: Account | null
  onUpdateAccount?: (id: string, updates: Partial<Account>) => Promise<void>
}

export function AddAccountDialog({
  open,
  onOpenChange,
  provider,
  onAddAccount,
  onValidateToken,
  editingAccount,
  onUpdateAccount,
}: AddAccountDialogProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<string>('manual')
  const [name, setName] = useState('')
  const [dailyLimit, setDailyLimit] = useState<string>('')
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    valid?: boolean
    error?: string
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isOAuthLoading, setIsOAuthLoading] = useState(false)
  const [oauthStatus, setOAuthStatus] = useState<string>('')
  // Populated when the in-app login window is unavailable (web build): the UI
  // then shows the provider's login URL and token copy steps instead.
  const [webLoginGuide, setWebLoginGuide] = useState<{
    loginUrl: string
    steps: string[]
    tokenKey: string
    tokenLabel: string
    storageType: 'localStorage' | 'cookie' | 'other'
    placeholder?: string
    helpUrl?: string
  } | null>(null)
  const [bookmarklet, setBookmarklet] = useState<string | null>(null)
  const [bookmarkletCopied, setBookmarkletCopied] = useState(false)

  // The guide panel is the mobile-friendly import path, so fetch the matching
  // bookmarklet alongside it.
  useEffect(() => {
    if (!webLoginGuide || !provider?.id) {
      setBookmarklet(null)
      return
    }
    let cancelled = false
    window.electronAPI?.oauth
      .getBookmarklet(provider.id)
      .then((value) => {
        if (!cancelled) setBookmarklet(value)
      })
      .catch(() => {
        if (!cancelled) setBookmarklet(null)
      })
    return () => {
      cancelled = true
    }
  }, [webLoginGuide, provider?.id])

  const isEditing = !!editingAccount
  const builtinProvider = provider as BuiltinProviderConfig | null
  const credentialFields: CredentialField[] = builtinProvider?.credentialFields || getDefaultCredentialFields(provider?.authType, t)
  const supportsOAuth = provider && ['deepseek', 'glm', 'kimi', 'mimo', 'minimax', 'qwen', 'qwen-ai', 'zai', 'perplexity'].includes(provider.id)

  useEffect(() => {
    if (open) {
      if (editingAccount) {
        setName(editingAccount.name)
        setDailyLimit(editingAccount.dailyLimit?.toString() || '')
        setCredentials(editingAccount.credentials || {})
        setActiveTab('manual')
      } else {
        resetForm()
      }
    }
  }, [open, editingAccount])

  const resetForm = () => {
    setName('')
    setDailyLimit('')
    setCredentials({})
    setValidationResult({})
    setActiveTab('manual')
    setIsOAuthLoading(false)
    setOAuthStatus('')
  }

  const handleCredentialChange = (fieldName: string, value: string) => {
    setCredentials(prev => ({
      ...prev,
      [fieldName]: value,
    }))
    setValidationResult({})
  }

  const handleValidate = async () => {
    if (!provider) return

    const requiredFields = credentialFields.filter(f => f.required)
    const missingFields = requiredFields.filter(f => !credentials[f.name])
    
    if (missingFields.length > 0) {
      setValidationResult({
        valid: false,
        error: t('providers.fillRequiredFields', { fields: missingFields.map(f => f.label).join(', ') }),
      })
      return
    }

    setIsValidating(true)
    setValidationResult({})

    try {
      const result = await onValidateToken(provider.id, credentials)
      setValidationResult(result)

      if (result.valid && result.userInfo) {
        if (!name && result.userInfo.name) {
          setName(result.userInfo.name)
        }
      }
    } catch (error) {
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : t('providers.validateFailed'),
      })
    } finally {
      setIsValidating(false)
    }
  }

  const handleSubmit = async () => {
    if (!name.trim()) {
      setValidationResult({
        valid: false,
        error: t('providers.enterAccountName'),
      })
      return
    }

    const requiredFields = credentialFields.filter(f => f.required)
    const missingFields = requiredFields.filter(f => !credentials[f.name])
    
    if (missingFields.length > 0) {
      setValidationResult({
        valid: false,
        error: t('providers.fillRequiredFields', { fields: missingFields.map(f => f.label).join(', ') }),
      })
      return
    }

    setIsSubmitting(true)

    try {
      // For MiniMax, ensure realUserID is passed correctly
      let finalCredentials = { ...credentials }
      if (provider?.id === 'minimax' && credentials.realUserID && credentials.realUserID.trim()) {
        // realUserID is provided separately, keep both fields
        console.log('[AddAccountDialog] MiniMax realUserID provided:', credentials.realUserID)
      }

      const data = {
        name: name.trim(),
        credentials: finalCredentials,
        dailyLimit: dailyLimit ? parseInt(dailyLimit, 10) : undefined,
      }

      if (isEditing && editingAccount && onUpdateAccount) {
        await onUpdateAccount(editingAccount.id, data)
      } else {
        await onAddAccount(data)
      }

      onOpenChange(false)
      resetForm()
    } catch (error) {
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : t('providers.saveFailed'),
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleOpenOAuthBrowser = async () => {
    if (!provider) return
    
    setIsOAuthLoading(true)
    setOAuthStatus(t('providers.openingLoginWindow'))
    
    try {
      const result = await window.electronAPI?.oauth.startInAppLogin(
        provider.id,
        provider.id as ProviderVendor
      )
      
      if (result?.success && result.credentials) {
        // Map OAuth credentials to provider credential field names
        const mappedCredentials = mapOAuthCredentials(provider?.id, result.credentials)
        setCredentials(mappedCredentials)
        setOAuthStatus(t('providers.loginSuccess'))
        
        if (result.accountInfo?.name) {
          setName(result.accountInfo.name)
        }
        
        setValidationResult({
          valid: true,
          userInfo: result.accountInfo
        })
      } else {
        const errorMsg = result?.error || ''

        // The web build has no in-app Chromium window to scrape, so the main
        // process reports that the login window could not be opened. Fall back
        // to the 9router-style flow: open the provider site in a real tab and
        // let the user paste the token into the manual form.
        const noWindow =
          !errorMsg ||
          /login window|window was closed|not available|unsupported/i.test(errorMsg)

        if (noWindow) {
          const guides = await window.electronAPI?.oauth.getGuides?.()
          const guide = guides?.[provider.id]
          if (guide) {
            setWebLoginGuide(guide)
            setActiveTab('manual')
            setOAuthStatus('')
            return
          }
        }

        const translatedError = errorMsg === 'Login window was closed' 
          ? t('providers.loginWindowClosed')
          : errorMsg === 'A login window is already open'
            ? t('providers.loginWindowAlreadyOpen')
            : errorMsg.includes('Guest account') 
              ? t('providers.guestAccountNotAllowed')
              : errorMsg || t('providers.loginFailed')
        setOAuthStatus(translatedError)
      }
    } catch (error) {
      // Same fallback when the IPC call itself fails (headless bridge, etc.).
      try {
        const guides = await window.electronAPI?.oauth.getGuides?.()
        const guide = guides?.[provider.id]
        if (guide) {
          setWebLoginGuide(guide)
          setActiveTab('manual')
          setOAuthStatus('')
          return
        }
      } catch {
        // fall through to the generic message
      }
      const errorMessage = error instanceof Error ? error.message : t('providers.loginFailed')
      setOAuthStatus(errorMessage)
    } finally {
      setIsOAuthLoading(false)
    }
  }

  if (!provider) return null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              {isEditing ? t('providers.editAccount') : t('providers.addAccount')}
            </DialogTitle>
            <DialogDescription>
              {t('providers.manageAllAccounts')} - {provider.name}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('providers.accountName')} *</Label>
              <Input
                id="name"
                placeholder={t('providers.accountNamePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dailyLimit">{t('providers.dailyLimitOptional')}</Label>
              <Input
                id="dailyLimit"
                type="number"
                placeholder={t('providers.dailyLimitPlaceholder')}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
              />
            </div>

            {supportsOAuth && !isEditing && (
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="manual">{t('providers.manualInput')}</TabsTrigger>
                  <TabsTrigger value="oauth">{t('providers.oauthLogin')}</TabsTrigger>
                </TabsList>

                <TabsContent value="manual" className="mt-4">
                  {webLoginGuide && (
                    <div
                      data-testid="web-login-guide"
                      className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
                    >
                      <p className="mb-2 font-medium">
                        Login on the provider's site, then import the {webLoginGuide.tokenLabel}.
                      </p>
                      <ol className="mb-3 list-decimal space-y-1 pl-5 text-muted-foreground">
                        {webLoginGuide.steps.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ol>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() =>
                            window.electronAPI?.invoke('app:openExternal', webLoginGuide.loginUrl)
                          }
                        >
                          <ExternalLink className="mr-1 h-3.5 w-3.5" />
                          Open {new URL(webLoginGuide.loginUrl).hostname}
                        </Button>

                        {/*
                          The bookmarklet runs on the provider's own page, so the
                          token is copied where the real login happened. It can be
                          dragged to the bookmarks bar, or copied and pasted into a
                          bookmark's URL field — the mobile-friendly path.
                        */}
                        {bookmarklet && (
                          <>
                            <a
                              href={bookmarklet}
                              draggable
                              onClick={(e) => e.preventDefault()}
                              className="inline-flex cursor-move items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
                              title="Drag this to your bookmarks bar, or add it as a bookmark"
                            >
                              <Bookmark className="mr-1 h-3.5 w-3.5" />
                              Copy {webLoginGuide.tokenLabel} (bookmarklet)
                            </a>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={async () => {
                                await navigator.clipboard?.writeText(bookmarklet)
                                setBookmarkletCopied(true)
                                setTimeout(() => setBookmarkletCopied(false), 2000)
                              }}
                            >
                              {bookmarkletCopied ? (
                                <><Check className="mr-1 h-3.5 w-3.5" />Copied</>
                              ) : (
                                <><Copy className="mr-1 h-3.5 w-3.5" />Copy code</>
                              )}
                            </Button>
                          </>
                        )}
                      </div>

                      {bookmarklet && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Create a bookmark in your phone browser whose URL is the copied code,
                          open it while logged in on {new URL(webLoginGuide.loginUrl).hostname}, and
                          the token is copied for you.
                        </p>
                      )}

                      <span className="mt-2 block text-xs text-muted-foreground">
                        Field: <code className="rounded bg-muted px-1">{webLoginGuide.tokenKey}</code>
                      </span>
                    </div>
                  )}
                  <CredentialFieldsForm
                    fields={credentialFields}
                    credentials={credentials}
                    onChange={handleCredentialChange}
                    t={t}
                    providerId={provider?.id}
                  />
                </TabsContent>

                <TabsContent value="oauth" className="mt-4">
                  <div className="flex flex-col items-center justify-center py-6 space-y-4">
                    <div className="text-center">
                      <p className="text-sm text-muted-foreground mb-4">
                        {t('providers.clickToOpenOAuth')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('providers.oauthAutoCapture')}
                      </p>
                    </div>
                    <Button 
                      onClick={handleOpenOAuthBrowser}
                      disabled={isOAuthLoading}
                      data-testid="oauth-login-button"
                    >
                      {isOAuthLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {oauthStatus || t('providers.loggingIn')}
                        </>
                      ) : (
                        <>
                          <ExternalLink className="mr-2 h-4 w-4" />
                          {t('providers.openOAuthLogin')}
                        </>
                      )}
                    </Button>
                    {oauthStatus && !isOAuthLoading && (
                      <p className={`text-sm ${validationResult.valid ? 'text-green-600' : 'text-red-500'}`}>
                        {oauthStatus}
                      </p>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            )}

            {(!supportsOAuth || isEditing) && (
              <CredentialFieldsForm
                fields={credentialFields}
                credentials={credentials}
                onChange={handleCredentialChange}
                t={t}
                providerId={provider?.id}
              />
            )}

            {validationResult.error && (
              <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 p-3 rounded-lg">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{validationResult.error}</span>
              </div>
            )}

            {validationResult.valid && validationResult.userInfo && (
              <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 p-3 rounded-lg">
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                <div>
                  <span className="font-medium">{t('providers.validationSuccess')}</span>
                  {validationResult.userInfo.quota !== undefined && (
                    <span className="ml-2">
                      {t('providers.quota')}: {validationResult.userInfo.used || 0} / {validationResult.userInfo.quota}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="mt-6">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              onClick={handleValidate}
              disabled={isValidating || isSubmitting}
            >
              {isValidating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('oauth.validating')}
                </>
              ) : (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  {t('providers.validateCredentials')}
                </>
              )}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting || isValidating}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('providers.saving')}
                </>
              ) : (
                isEditing ? t('providers.saveChanges') : t('providers.addAccount')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface CredentialFieldsFormProps {
  fields: CredentialField[]
  credentials: Record<string, string>
  onChange: (fieldName: string, value: string) => void
  t: (key: string) => string
  providerId?: string
}

function CredentialFieldsForm({ fields, credentials, onChange, t, providerId }: CredentialFieldsFormProps) {
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({})
  const [copiedFields, setCopiedFields] = useState<Record<string, boolean>>({})

  const toggleFieldVisibility = (fieldName: string) => {
    setVisibleFields(prev => ({
      ...prev,
      [fieldName]: !prev[fieldName]
    }))
  }

  const copyToClipboard = async (fieldName: string, value: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopiedFields(prev => ({ ...prev, [fieldName]: true }))
      setTimeout(() => {
        setCopiedFields(prev => ({ ...prev, [fieldName]: false }))
      }, 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const getFieldTranslation = (field: CredentialField) => {
    if (!providerId) return { label: field.label, placeholder: field.placeholder, helpText: field.helpText }

    const translations: Record<string, Record<string, { label: string; placeholder: string; helpText: string }>> = {
      deepseek: {
        token: {
          label: t('deepseek.userToken'),
          placeholder: t('deepseek.userTokenPlaceholder'),
          helpText: t('deepseek.userTokenHelp'),
        },
      },
      glm: {
        refresh_token: {
          label: t('glm.refreshToken'),
          placeholder: t('glm.refreshTokenPlaceholder'),
          helpText: t('glm.refreshTokenHelp'),
        },
      },
      kimi: {
        token: {
          label: t('kimi.accessToken'),
          placeholder: t('kimi.accessTokenPlaceholder'),
          helpText: t('kimi.accessTokenHelp'),
        },
      },
      minimax: {
        token: {
          label: t('minimax.token'),
          placeholder: t('minimax.tokenPlaceholder'),
          helpText: t('minimax.tokenHelp'),
        },
        realUserID: {
          label: t('minimax.realUserID'),
          placeholder: t('minimax.realUserIDPlaceholder'),
          helpText: t('minimax.realUserIDHelp'),
        },
      },
      qwen: {
        ticket: {
          label: t('qwen.ssoTicket'),
          placeholder: t('qwen.ssoTicketPlaceholder'),
          helpText: t('qwen.ssoTicketHelp'),
        },
      },
      'qwen-ai': {
        token: {
          label: t('qwen-ai.token'),
          placeholder: t('qwen-ai.tokenPlaceholder'),
          helpText: t('qwen-ai.tokenHelp'),
        },
        cookies: {
          label: t('qwen-ai.cookies'),
          placeholder: t('qwen-ai.cookiesPlaceholder'),
          helpText: t('qwen-ai.cookiesHelp'),
        },
      },
      zai: {
        token: {
          label: t('zai.token'),
          placeholder: t('zai.tokenPlaceholder'),
          helpText: t('zai.tokenHelp'),
        },
      },
      mimo: {
        service_token: {
          label: t('mimo.serviceToken'),
          placeholder: t('mimo.serviceTokenPlaceholder'),
          helpText: t('mimo.serviceTokenHelp'),
        },
        user_id: {
          label: t('mimo.userId'),
          placeholder: t('mimo.userIdPlaceholder'),
          helpText: t('mimo.userIdHelp'),
        },
        ph_token: {
          label: t('mimo.phToken'),
          placeholder: t('mimo.phTokenPlaceholder'),
          helpText: t('mimo.phTokenHelp'),
        },
      },
      perplexity: {
        sessionToken: {
          label: t('perplexity.sessionToken'),
          placeholder: t('perplexity.sessionTokenPlaceholder'),
          helpText: t('perplexity.sessionTokenHelp'),
        },
      },
    }

    const providerTranslations = translations[providerId]
    if (providerTranslations && providerTranslations[field.name]) {
      return providerTranslations[field.name]
    }

    return { label: field.label, placeholder: field.placeholder, helpText: field.helpText }
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const translated = getFieldTranslation(field)
        const isPasswordField = field.type === 'password'
        const isVisible = visibleFields[field.name]
        const isCopied = copiedFields[field.name]
        const fieldValue = credentials[field.name] || ''
        
        return (
          <div key={field.name} className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor={field.name}>{translated.label}</Label>
              {field.required && (
                <Badge variant="outline" className="text-xs">{t('providers.required')}</Badge>
              )}
            </div>
            {field.type === 'textarea' ? (
              <div className="relative">
                <textarea
                  id={field.name}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 pr-20"
                  placeholder={translated.placeholder}
                  value={fieldValue}
                  onChange={(e) => onChange(field.name, e.target.value)}
                />
                <div className="absolute right-1 top-1 flex gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => copyToClipboard(field.name, fieldValue)}
                    disabled={!fieldValue}
                  >
                    {isCopied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => toggleFieldVisibility(field.name)}
                  >
                    {isVisible ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
              </div>
            ) : isPasswordField ? (
              <div className="relative">
                <Input
                  id={field.name}
                  type={isVisible ? 'text' : 'password'}
                  placeholder={translated.placeholder}
                  value={fieldValue}
                  onChange={(e) => onChange(field.name, e.target.value)}
                  className="pr-20"
                />
                <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => copyToClipboard(field.name, fieldValue)}
                    disabled={!fieldValue}
                  >
                    {isCopied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => toggleFieldVisibility(field.name)}
                  >
                    {isVisible ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <Input
                id={field.name}
                type={field.type}
                placeholder={translated.placeholder}
                value={fieldValue}
                onChange={(e) => onChange(field.name, e.target.value)}
              />
            )}
            {translated.helpText && (
              <p className="text-xs text-muted-foreground">{translated.helpText}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function getDefaultCredentialFields(authType?: string, t?: (key: string) => string): CredentialField[] {
  const fieldConfigs: Record<string, CredentialField[]> = {
    token: [
      {
        name: 'token',
        label: 'API Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterApiToken') : 'Enter API Token',
      },
    ],
    cookie: [
      {
        name: 'cookie',
        label: 'Cookie',
        type: 'textarea',
        required: true,
        placeholder: t ? t('providers.enterCookieString') : 'Enter complete Cookie string',
      },
    ],
    oauth: [
      {
        name: 'access_token',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterOAuthAccessToken') : 'Enter OAuth Access Token',
      },
    ],
    refresh_token: [
      {
        name: 'refresh_token',
        label: 'Refresh Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterRefreshToken') : 'Enter Refresh Token',
      },
    ],
    jwt: [
      {
        name: 'jwt',
        label: 'JWT Token',
        type: 'textarea',
        required: true,
        placeholder: t ? t('providers.enterJwtToken') : 'Enter JWT Token (starts with eyJ)',
      },
    ],
  }

  return fieldConfigs[authType || 'token'] || fieldConfigs.token
}

export default AddAccountDialog
