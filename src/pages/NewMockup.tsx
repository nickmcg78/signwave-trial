import { useRef, useState } from 'react'
import type { ChangeEvent, Dispatch, SetStateAction } from 'react'
import { useNavigate, Link } from 'react-router-dom'

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
        return state.signs.length > 0
      case 4:
        return (state.signs[0]?.spec.length ?? 0) >= 10
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

  function handleGenerate() {
    // TODO Session 3: replace with edge function call + job polling
    console.log('Wizard state:', state)
    setGenerating(true)
    setTimeout(() => {
      navigate('/')
    }, 1000)
  }

  function handleBack() {
    if (currentStep > 1) {
      setCurrentStep((currentStep - 1) as 1 | 2 | 3 | 4)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header with Cancel */}
      <header className="bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between sticky top-0 z-10">
        <h1 className="text-base font-semibold text-gray-900">New Mockup</h1>
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
          </p>
        </div>
      </div>

      {/* Step body */}
      <main className="flex-1 px-4 py-6 max-w-lg w-full mx-auto pb-32">
        {currentStep === 1 && <StepPhoto state={state} setState={setState} />}
        {currentStep === 2 && <StepLogo state={state} setState={setState} />}
        {currentStep === 3 && <StepType state={state} setState={setState} />}
        {currentStep === 4 && <StepSpec state={state} setState={setState} />}
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
        <div className="max-w-lg mx-auto w-full grid grid-cols-3 gap-3">
          <button
            onClick={handleBack}
            disabled={currentStep === 1 || generating}
            className="min-w-0 h-14 border border-gray-300 text-gray-700 font-semibold rounded-xl text-base active:bg-gray-100 disabled:opacity-40 disabled:pointer-events-none"
          >
            Back
          </button>
          <button
            onClick={handleNext}
            disabled={!canContinue() || generating}
            className="col-span-2 min-w-0 h-14 bg-blue-600 active:bg-blue-800 text-white font-semibold rounded-xl text-base disabled:bg-blue-300"
          >
            {currentStep === 4
              ? generating
                ? 'Preparing…'
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
            className="mt-4 w-full min-h-14 border border-gray-300 text-gray-700 font-semibold rounded-xl text-base active:bg-gray-100"
          >
            Change photo
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openFilePicker}
          className="mt-6 w-full min-h-14 bg-blue-600 active:bg-blue-800 text-white font-semibold rounded-xl text-base"
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
            className="mt-4 w-full min-h-14 border border-gray-300 text-gray-700 font-semibold rounded-xl text-base active:bg-gray-100"
          >
            Change logo
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openFilePicker}
          className="mt-6 w-full min-h-14 bg-blue-600 active:bg-blue-800 text-white font-semibold rounded-xl text-base"
        >
          Choose logo
        </button>
      )}
    </div>
  )
}

// Canonical list of sign types the franchise supports. If more get added
// later, append to this array — the grid and selection logic handle any count.
const SIGN_TYPES: { id: string; name: string; description: string }[] = [
  {
    id: 'fascia_panel',
    name: 'Fascia Panel',
    description: 'Flat panel mounted to building face',
  },
  {
    id: 'illuminated_fascia',
    name: 'Illuminated Fascia',
    description: 'Lightbox or backlit fascia sign',
  },
  {
    id: 'blade_sign',
    name: 'Blade Sign',
    description: 'Projects perpendicular from the building',
  },
  {
    id: 'window_vinyl',
    name: 'Window Vinyl',
    description: 'Applied directly to glass',
  },
  {
    id: 'dimensional_letters',
    name: 'Dimensional Letters',
    description: 'Individual 3D letters mounted to surface',
  },
  {
    id: 'monument_sign',
    name: 'Monument Sign',
    description: 'Freestanding sign at ground level',
  },
]

function StepType({ state, setState }: StepProps) {
  function selectType(id: string) {
    // Preserve any spec the user has already typed on step 4 if they come
    // back to change the sign type.
    setState(prev => ({
      ...prev,
      signs:
        prev.signs.length > 0
          ? [{ ...prev.signs[0], signType: id }]
          : [{ signType: id, spec: '' }],
    }))
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900">What type of sign?</h2>

      <div className="mt-6 grid grid-cols-2 gap-3">
        {SIGN_TYPES.map(type => {
          const isSelected = state.signs[0]?.signType === type.id
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

function StepSpec({ state, setState }: StepProps) {
  const spec = state.signs[0]?.spec ?? ''
  const signTypeId = state.signs[0]?.signType ?? ''
  const showReview = spec.length >= 10

  function handleSpecChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value
    setState(prev => ({
      ...prev,
      signs:
        prev.signs.length > 0
          ? [{ ...prev.signs[0], spec: value }]
          : [{ signType: '', spec: value }],
    }))
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900">Describe the sign</h2>
      <p className="text-gray-500 text-sm mt-1">
        Include size, finish, colours, or anything specific.
      </p>

      {/* 16px font size is required — iOS Safari auto-zooms in on any
          input/textarea with a computed font-size smaller than 16px.
          text-base = 1rem = 16px, but we set it inline too as a belt-and-braces
          defence against the base font size ever being changed globally. */}
      <textarea
        value={spec}
        onChange={handleSpecChange}
        rows={4}
        placeholder="e.g. 6m wide aluminium fascia panel, white background, navy text, satin finish"
        style={{ fontSize: '16px' }}
        className="mt-6 w-full text-base rounded-xl border border-gray-300 p-4 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
      />

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
              <span className="inline-block text-xs font-medium bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                {signTypeName(signTypeId)}
              </span>
              <p className="text-sm text-gray-700 mt-2 line-clamp-2">{spec}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Map a SIGN_TYPES id (e.g. 'fascia_panel') back to its display label
// ('Fascia Panel'). Falls back to the raw id if we ever get an unknown value.
function signTypeName(id: string): string {
  return SIGN_TYPES.find(t => t.id === id)?.name ?? id
}
