import { useRef, useState } from 'react'
import type { ChangeEvent, Dispatch, SetStateAction } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import SignZoneSelector from '../components/SignZoneSelector'
import type { SignZone } from '../components/SignZoneSelector'

// Maps the wizard's internal sign type IDs to the IDs the edge function expects.
// The edge function has its own vocabulary inherited from the original prompt
// template — we translate at the boundary rather than renaming either side.
const SIGN_TYPE_MAP: Record<string, string> = {
  fascia_panel: 'fascia-panel',
  illuminated_dimensional_letters: '3d-letters',
  dimensional_letters: '3d-letters',
  lightbox: 'lightbox',
  window_vinyl: 'window-perf',
}

// Read a File into a base64 data URL. We POST these to the edge function
// rather than uploading to Storage first, because the edge function already
// accepts data URLs and this keeps the trial prototype single-hop.
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

/**
 * NewMockup — 4-step wizard scaffold
 *
 * All wizard state lives in this component. We pass pieces down to step
 * components via props. Nothing is persisted to Supabase yet — that comes
 * in session 3 when we wire up the edge function.
 */

// A single sign being described in the wizard. For now the wizard only
// supports one, but we shape it as an array so later sessions can add a
// "describe multiple signs in one mockup" flow without a second rename.
type Sign = {
  signType: string
  spec: string
  replaceExisting: boolean
  contactDetails: string
  signZone: SignZone | null
}

type WizardState = {
  photo: File | null
  photoPreviewUrl: string | null
  logo: File | null
  logoPreviewUrl: string | null
  signs: Sign[]
}

const INITIAL_STATE: WizardState = {
  photo: null,
  photoPreviewUrl: null,
  logo: null,
  logoPreviewUrl: null,
  signs: [],
}

const STEPS = [
  { n: 1, label: 'Photo' },
  { n: 2, label: 'Logo' },
  { n: 3, label: 'Type' },
  { n: 4, label: 'Details' },
] as const

export default function NewMockup() {
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4>(1)
  const [state, setState] = useState<WizardState>(INITIAL_STATE)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [currentSignIndex, setCurrentSignIndex] = useState(0)

  // Whether the current step has enough data for Next to be enabled.
  // For now (placeholders), Next is always enabled so you can click through.
  // In the next task we'll wire these to real field requirements.
  function canContinue(): boolean {
    switch (currentStep) {
      case 1:
        return state.photo !== null
      case 2:
        return state.logo !== null
      case 3:
        return !!state.signs[currentSignIndex]?.signType
      case 4:
        return (state.signs[currentSignIndex]?.spec.length ?? 0) >= 10 && state.signs[currentSignIndex]?.signZone !== null
      default:
        return false
    }
  }

  function handleNext() {
    if (currentStep < 4) {
      setCurrentStep((currentStep + 1) as 1 | 2 | 3 | 4)
    } else {
      handleGenerate()
    }
  }

  async function handleGenerate() {
    if (!state.photo || !state.logo || state.signs.length === 0) {
      setGenerateError('Please complete all wizard steps before generating.')
      return
    }

    setGenerateError(null)
    setGenerating(true)

    try {
      // Base64 the two files in parallel — these are small enough (phone photos
      // + logos) that reading them sequentially would just add latency.
      const [photoDataUrl, logoDataUrl] = await Promise.all([
        fileToDataUrl(state.photo),
        fileToDataUrl(state.logo),
      ])

      // Burn a visible marker onto the building photo for each sign zone.
      // We composite a bright cyan rectangle onto a copy of the photo so the
      // AI model can visually see where to place each sign.
      async function compositeMarker(
        photoDataUrl: string,
        zone: SignZone,
      ): Promise<string> {
        return new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => {
            const canvas = document.createElement('canvas')
            canvas.width = img.naturalWidth
            canvas.height = img.naturalHeight
            const ctx = canvas.getContext('2d')
            if (!ctx) { reject(new Error('Canvas not supported')); return }

            // Draw original photo
            ctx.drawImage(img, 0, 0)

            // Convert zone percentages to pixels
            const rawX = (zone.xPct / 100) * canvas.width
            const rawY = (zone.yPct / 100) * canvas.height
            const rawW = (zone.wPct / 100) * canvas.width
            const rawH = (zone.hPct / 100) * canvas.height

            // Inset the marker by ~15% on each side so the sign doesn't fill
            // the entire zone edge-to-edge. The franchisee sees the full box
            // they drew, but the AI sees a tighter target with breathing room.
            const INSET = 0.15
            const x = rawX + rawW * INSET
            const y = rawY + rawH * INSET
            const w = rawW * (1 - INSET * 2)
            const h = rawH * (1 - INSET * 2)

            // Draw semi-transparent cyan fill
            ctx.fillStyle = 'rgba(0, 255, 255, 0.25)'
            ctx.fillRect(x, y, w, h)

            // Draw bright cyan border (thick enough for the model to see)
            ctx.strokeStyle = 'rgba(0, 255, 255, 0.9)'
            ctx.lineWidth = Math.max(4, Math.round(canvas.width * 0.005))
            ctx.strokeRect(x, y, w, h)

            resolve(canvas.toDataURL('image/jpeg', 0.92))
          }
          img.onerror = () => reject(new Error('Failed to load photo for marker'))
          img.src = photoDataUrl
        })
      }

      // Build the marked-up photo for the first sign's zone.
      // For multi-sign, the edge function handles subsequent signs
      // (their zones are sent as coordinates and applied to intermediate outputs).
      const firstZone = state.signs[0]?.signZone
      const markedPhotoUrl = firstZone
        ? await compositeMarker(photoDataUrl, firstZone)
        : photoDataUrl

      const mappedSigns = state.signs.map(s => {
        // When replacing, prepend the replacement framing to the spec so the
        // AI knows to swap the existing sign rather than add a second one.
        const signTypeName = SIGN_TYPES.find(t => t.id === s.signType)?.name ?? s.signType
        const replacePreamble = REPLACE_PREFIX.replace('[sign type]', signTypeName)
        const fullSpec = s.replaceExisting
          ? `${replacePreamble}\n\n${s.spec}`
          : s.spec

        return {
          signType: SIGN_TYPE_MAP[s.signType] ?? 'fascia-panel',
          signPosition: fullSpec,
          replaceExisting: s.replaceExisting,
          existingSignDescription: '',
          contactDetails: s.contactDetails || '',
          signZone: s.signZone,
        }
      })

      const { data, error } = await supabase.functions.invoke('generate-mockup', {
        body: {
          shopImageUrl: markedPhotoUrl,
          logoUrl: logoDataUrl,
          tagline: '',
          size: 'medium',
          finish: 'standard',
          illumination: 'standard',
          timeOfDay: 'day',
          signs: mappedSigns,
        },
      })

      if (error) {
        // supabase-js wraps non-2xx responses in a FunctionsHttpError. The
        // JSON error body is usually reachable via error.context.
        throw error
      }

      const jobId = (data as { jobId?: string } | null)?.jobId
      if (!jobId) {
        throw new Error('Edge function did not return a jobId.')
      }

      navigate(`/result/${jobId}`)
    } catch (err: unknown) {
      console.error('[NewMockup] Generate failed:', err)
      const message =
        err instanceof Error
          ? err.message
          : 'Something went wrong generating your mockup. Please try again.'
      setGenerateError(message)
      setGenerating(false)
    }
  }

  function handleBack() {
    if (currentStep === 3 && currentSignIndex > 0) {
      // Abandoning current sign — remove it and return to previous sign's spec
      setState(prev => ({
        ...prev,
        signs: prev.signs.slice(0, currentSignIndex),
      }))
      setCurrentSignIndex(currentSignIndex - 1)
      setCurrentStep(4)
    } else if (currentStep > 1) {
      setCurrentStep((currentStep - 1) as 1 | 2 | 3 | 4)
    }
  }

  function handleAddSign() {
    if (currentSignIndex >= 2) return // Max 3 signs (indices 0, 1, 2)
    setCurrentSignIndex(prev => prev + 1)
    setCurrentStep(3)
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header with Cancel */}
      <header className="bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <img src="/signwave-logo.png" alt="Signwave" className="h-6 w-auto" />
          <span className="text-sm text-gray-400">|</span>
          <span className="text-sm font-semibold text-gray-900">New Mockup</span>
        </div>
        <Link
          to="/"
          className="text-sm text-gray-500 active:text-gray-800 px-3 py-2 rounded-lg"
        >
          Cancel
        </Link>
      </header>

      {/* Progress bar: 4 segments */}
      <div className="bg-white px-4 pb-4 border-b border-gray-200">
        <div className="max-w-lg mx-auto">
          <div className="flex gap-2">
            {STEPS.map(s => (
              <div
                key={s.n}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  currentStep >= s.n ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              />
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Step {currentStep} of 4 — {STEPS[currentStep - 1].label}
            {currentStep >= 3 && currentSignIndex > 0 && ` (Sign ${currentSignIndex + 1})`}
          </p>
        </div>
      </div>

      {/* Step body */}
      <main className="flex-1 px-4 py-6 max-w-lg w-full mx-auto pb-32">
        {currentStep === 1 && <StepPhoto state={state} setState={setState} signIndex={currentSignIndex} />}
        {currentStep === 2 && <StepLogo state={state} setState={setState} signIndex={currentSignIndex} />}
        {currentStep === 3 && <StepType state={state} setState={setState} signIndex={currentSignIndex} />}
        {currentStep === 4 && <StepSpec state={state} setState={setState} signIndex={currentSignIndex} onAddSign={handleAddSign} />}
      </main>

      {/* Sticky footer: Back / Next */}
      <div
        className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200"
        style={{
          paddingLeft: 'max(1.25rem, env(safe-area-inset-left))',
          paddingRight: 'max(1.25rem, env(safe-area-inset-right))',
          paddingTop: '0.75rem',
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
        }}
      >
        {generateError && (
          <div className="max-w-lg mx-auto w-full mb-3">
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              {generateError}
            </div>
          </div>
        )}
        <div className="max-w-lg mx-auto w-full grid grid-cols-3 gap-3">
          <button
            onClick={handleBack}
            disabled={currentStep === 1 || generating}
            className="min-w-0 min-h-[60px] border border-gray-300 text-gray-700 font-semibold rounded-xl text-base active:bg-gray-100 disabled:opacity-40 disabled:pointer-events-none"
          >
            Back
          </button>
          <button
            onClick={handleNext}
            disabled={!canContinue() || generating}
            className="col-span-2 min-w-0 min-h-[60px] bg-blue-600 active:bg-blue-800 text-white font-semibold rounded-xl text-base disabled:bg-blue-300"
          >
            {currentStep === 4
              ? generating
                ? 'Generating…'
                : 'Generate Mockup'
              : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Placeholder step components ---------------------------------

type StepProps = {
  state: WizardState
  setState: Dispatch<SetStateAction<WizardState>>
  signIndex: number
  onAddSign?: () => void
}

function StepPhoto({ state, setState }: StepProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  function openFilePicker() {
    fileInputRef.current?.click()
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // Release any previous preview URL so we don't leak memory if the user
    // picks a second photo. Each createObjectURL allocates until revoked.
    if (state.photoPreviewUrl) {
      URL.revokeObjectURL(state.photoPreviewUrl)
    }

    const previewUrl = URL.createObjectURL(file)
    setState(prev => ({ ...prev, photo: file, photoPreviewUrl: previewUrl }))

    // Reset the input's value so picking the SAME file again still fires change.
    e.target.value = ''
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900">Upload a building photo</h2>
      <p className="text-gray-500 text-sm mt-1">
        Take a photo of the prospect's building, or upload one from your camera roll.
      </p>

      {/* Hidden native file input — triggered by the visible button below.
          accept="image/*" + capture="environment" tells iOS Safari to offer
          the rear camera directly, which is what a franchisee standing
          outside a shopfront actually wants. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        className="hidden"
      />

      {state.photoPreviewUrl ? (
        <div className="mt-6">
          <img
            src={state.photoPreviewUrl}
            alt="Building photo preview"
            className="w-full max-h-[300px] object-cover rounded-2xl border border-gray-200"
          />
          <button
            type="button"
            onClick={openFilePicker}
            className="mt-4 w-full min-h-[60px] border border-gray-300 text-gray-700 font-semibold rounded-xl text-base active:bg-gray-100"
          >
            Change photo
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openFilePicker}
          className="mt-6 w-full min-h-[60px] bg-blue-600 active:bg-blue-800 text-white font-semibold rounded-xl text-base"
        >
          Choose photo
        </button>
      )}
    </div>
  )
}

function StepLogo({ state, setState }: StepProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  function openFilePicker() {
    fileInputRef.current?.click()
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // Release any previous preview URL so we don't leak memory if the user
    // picks a second logo.
    if (state.logoPreviewUrl) {
      URL.revokeObjectURL(state.logoPreviewUrl)
    }

    const previewUrl = URL.createObjectURL(file)
    setState(prev => ({ ...prev, logo: file, logoPreviewUrl: previewUrl }))

    // Reset so picking the same file again still fires change.
    e.target.value = ''
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900">Upload the client's logo</h2>
      <p className="text-gray-500 text-sm mt-1">
        PNG with transparent background works best.
      </p>

      {/* No capture attribute — logos come from files, not the camera.
          Accept list is explicit so iOS doesn't offer camera as an option. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml"
        onChange={handleFileChange}
        className="hidden"
      />

      {state.logoPreviewUrl ? (
        <div className="mt-6">
          <div className="w-full bg-gray-100 rounded-2xl border border-gray-200 flex items-center justify-center p-4">
            <img
              src={state.logoPreviewUrl}
              alt="Client logo preview"
              className="max-h-[120px] w-auto object-contain"
            />
          </div>
          <button
            type="button"
            onClick={openFilePicker}
            className="mt-4 w-full min-h-[60px] border border-gray-300 text-gray-700 font-semibold rounded-xl text-base active:bg-gray-100"
          >
            Change logo
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openFilePicker}
          className="mt-6 w-full min-h-[60px] bg-blue-600 active:bg-blue-800 text-white font-semibold rounded-xl text-base"
        >
          Choose logo
        </button>
      )}
    </div>
  )
}

// Canonical list of sign types the franchise supports. Each entry includes a
// short description (shown under the type name in the selector) and a default
// spec that pre-fills the textarea when the type is chosen.
const SIGN_TYPES: { id: string; name: string; description: string; defaultSpec: string }[] = [
  {
    id: 'fascia_panel',
    name: 'Fascia Panel',
    description: 'Flat panel mounted flush to the building parapet or fascia band',
    defaultSpec:
      'Flat aluminium composite panel (ACM), mounted flush to the surface with no visible cabinet depth. Background colour from the brand palette. Logo reproduced accurately in contrasting colour.',
  },
  {
    id: 'illuminated_dimensional_letters',
    name: 'Illuminated Dimensional Letters',
    description: 'Halo or front-lit letters mounted directly to the building surface',
    defaultSpec:
      'Individual illuminated dimensional letters in brand colours, halo-lit or front-lit. Stainless or painted aluminium, 40mm depth, stud-mounted with even spacing. Each letter casts a natural shadow on the wall behind.',
  },
  {
    id: 'dimensional_letters',
    name: 'Dimensional Letters',
    description: 'Cut-out letters in metal or acrylic, mounted direct to wall',
    defaultSpec:
      'Individual cut-out dimensional letters in brushed aluminium or painted finish, 25mm depth. No backing panel — letters sit directly on the wall surface with visible shadow.',
  },
  {
    id: 'lightbox',
    name: 'Lightbox / Illuminated Fascia',
    description: 'Slim backlit cabinet with printed acrylic face',
    defaultSpec:
      'Slim-profile lightbox cabinet, 120mm deep, polished aluminium frame. White acrylic face with full-colour printed graphic. Even internal LED illumination.',
  },
  {
    id: 'window_vinyl',
    name: 'Window Vinyl',
    description: 'Printed or frosted vinyl applied directly to glass',
    defaultSpec:
      'Frosted white vinyl with logo reversed out in clear vinyl, applied directly to the glass surface.',
  },
]

function StepType({ state, setState, signIndex }: StepProps) {
  function selectType(id: string) {
    const defaultSpec = SIGN_TYPES.find(t => t.id === id)?.defaultSpec ?? ''
    setState(prev => {
      const newSigns = [...prev.signs]
      const existing = newSigns[signIndex]
      if (existing) {
        newSigns[signIndex] = { ...existing, signType: id, spec: defaultSpec }
      } else {
        newSigns[signIndex] = { signType: id, spec: defaultSpec, replaceExisting: true, contactDetails: '', signZone: null }
      }
      return { ...prev, signs: newSigns }
    })
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900">
        {signIndex > 0 ? `Sign ${signIndex + 1}: What type?` : 'What type of sign?'}
      </h2>

      <div className="mt-6 grid grid-cols-2 gap-3">
        {SIGN_TYPES.map(type => {
          const isSelected = state.signs[signIndex]?.signType === type.id
          return (
            <button
              key={type.id}
              type="button"
              onClick={() => selectType(type.id)}
              aria-pressed={isSelected}
              className={`min-h-20 p-3 rounded-xl border text-left transition-colors ${
                isSelected
                  ? 'ring-2 ring-blue-500 bg-blue-50 border-blue-500'
                  : 'border-gray-200 bg-white active:bg-gray-50'
              }`}
            >
              <div className="font-semibold text-gray-900 text-sm leading-tight">
                {type.name}
              </div>
              <div className="text-xs text-gray-500 mt-1 leading-snug">
                {type.description}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// The text prepended to the spec when "Replace existing sign" is selected.
// Keep this short — the marker now defines position and size, so this line
// only needs to tell the model to clear any old signage first.
const REPLACE_PREFIX =
  'Remove any existing signage underneath the marked area before installing the new [sign type]. Do not change the fascia dimensions or building structure.'

function StepSpec({ state, setState, signIndex, onAddSign }: StepProps) {
  const sign = state.signs[signIndex]
  const spec = sign?.spec ?? ''
  const replaceExisting = sign?.replaceExisting ?? true
  const contactDetails = sign?.contactDetails ?? ''
  const showReview = spec.length >= 10
  const canAddMore = signIndex < 2 && showReview

  function updateSign(patch: Partial<Sign>) {
    setState(prev => {
      const newSigns = [...prev.signs]
      if (newSigns[signIndex]) {
        newSigns[signIndex] = { ...newSigns[signIndex], ...patch }
      } else {
        newSigns[signIndex] = { signType: '', spec: '', replaceExisting: true, contactDetails: '', signZone: null, ...patch }
      }
      return { ...prev, signs: newSigns }
    })
  }

  function handleToggle(replace: boolean) {
    updateSign({ replaceExisting: replace })
  }

  function handleSpecChange(e: ChangeEvent<HTMLTextAreaElement>) {
    updateSign({ spec: e.target.value })
  }

  function handleContactChange(e: ChangeEvent<HTMLInputElement>) {
    updateSign({ contactDetails: e.target.value })
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900">
        {signIndex > 0 ? `Sign ${signIndex + 1}: Describe the sign` : 'Describe the sign'}
      </h2>

      {/* Sign zone selector — draw a rectangle on the building photo to
          define where this sign goes. Each sign gets its own zone. */}
      {state.photoPreviewUrl && (
        <SignZoneSelector
          photoUrl={state.photoPreviewUrl}
          initialZone={sign?.signZone ?? null}
          onZoneSelected={(zone) => updateSign({ signZone: zone })}
        />
      )}

      <p className="text-gray-500 text-sm mt-4">
        Include size, finish, colours, or anything specific.
      </p>

      {/* Replace vs Add toggle — segmented control */}
      <div className="mt-4 flex rounded-xl border border-gray-300 overflow-hidden">
        <button
          type="button"
          onClick={() => handleToggle(true)}
          className={`flex-1 min-h-[48px] text-sm font-semibold transition-colors ${
            replaceExisting
              ? 'bg-blue-600 text-white'
              : 'bg-white text-gray-600 active:bg-gray-50'
          }`}
        >
          Replace existing sign
        </button>
        <button
          type="button"
          onClick={() => handleToggle(false)}
          className={`flex-1 min-h-[48px] text-sm font-semibold border-l border-gray-300 transition-colors ${
            !replaceExisting
              ? 'bg-blue-600 text-white'
              : 'bg-white text-gray-600 active:bg-gray-50'
          }`}
        >
          Add new sign to building
        </button>
      </div>

      {/* Summary of previously configured signs */}
      {signIndex > 0 && (
        <div className="mt-4 space-y-2">
          {state.signs.slice(0, signIndex).map((s, i) => (
            <div
              key={i}
              className="bg-green-50 border border-green-200 rounded-xl px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-green-600 text-sm font-bold">&#10003;</span>
                <span className="text-sm font-semibold text-gray-900">
                  Sign {i + 1}: {signTypeName(s.signType)}
                </span>
              </div>
              <p className="text-sm text-gray-600 mt-1 line-clamp-1">{s.spec}</p>
            </div>
          ))}
        </div>
      )}

      {/* 16px font size is required — iOS Safari auto-zooms in on any
          input/textarea with a computed font-size smaller than 16px. */}
      <textarea
        value={spec}
        onChange={handleSpecChange}
        rows={5}
        placeholder="e.g. 6m wide aluminium fascia panel, white background, navy text, satin finish"
        style={{ fontSize: '16px' }}
        className="mt-4 w-full text-base rounded-xl border border-gray-300 p-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
      />

      {/* Contact details — optional single-line input */}
      <label className="block mt-4">
        <span className="text-sm font-medium text-gray-700">Contact details (optional)</span>
        <input
          type="text"
          value={contactDetails}
          onChange={handleContactChange}
          placeholder="e.g. 03 9123 4567  |  www.businessname.com.au"
          style={{ fontSize: '16px' }}
          className="mt-1 w-full min-h-[48px] text-base rounded-xl border border-gray-300 px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </label>

      {/* Info line */}
      <p className="mt-3 text-xs text-gray-400">
        This tool is designed for exterior shopfront signage only.
      </p>

      {showReview && (
        <div className="mt-6 bg-white rounded-2xl border border-gray-200 p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Review
          </p>
          <div className="flex items-start gap-3">
            {state.photoPreviewUrl && (
              <img
                src={state.photoPreviewUrl}
                alt="Building"
                className="w-[60px] h-[60px] object-cover rounded-lg border border-gray-200 flex-shrink-0"
              />
            )}
            {state.logoPreviewUrl && (
              <div className="w-[60px] h-[60px] rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center flex-shrink-0">
                <img
                  src={state.logoPreviewUrl}
                  alt="Logo"
                  className="max-w-full max-h-full object-contain p-1"
                />
              </div>
            )}
            <div className="min-w-0 flex-1">
              {state.signs.slice(0, signIndex + 1).map((s, i) => (
                <div key={i} className={i > 0 ? 'mt-2 pt-2 border-t border-gray-100' : ''}>
                  <span className="inline-block text-xs font-medium bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                    {state.signs.length > 1 || signIndex > 0
                      ? `Sign ${i + 1}: ${signTypeName(s.signType)}`
                      : signTypeName(s.signType)}
                  </span>
                  <p className="text-sm text-gray-700 mt-1 line-clamp-2">{s.spec}</p>
                  {s.contactDetails && (
                    <p className="text-xs text-gray-500 mt-1">Contact: {s.contactDetails}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Optional add-sign button — secondary action, Generate stays primary in footer */}
      {canAddMore && onAddSign && (
        <button
          type="button"
          onClick={onAddSign}
          className="mt-4 w-full min-h-[48px] border border-dashed border-gray-300 text-gray-600 font-medium rounded-xl text-sm active:bg-gray-50 cursor-pointer"
        >
          + Add Sign {signIndex + 2} (optional)
        </button>
      )}
    </div>
  )
}

// Map a SIGN_TYPES id (e.g. 'fascia_panel') back to its display label
// ('Fascia Panel'). Falls back to the raw id if we ever get an unknown value.
function signTypeName(id: string): string {
  return SIGN_TYPES.find(t => t.id === id)?.name ?? id
}
