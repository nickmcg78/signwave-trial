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
  under_awning_lightbox: 'under-awning-lightbox',
  blade_sign: 'blade-sign',
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

      // The building photo is sent UNMODIFIED. The edge function generates
      // a transparent PNG mask from each sign's signZone coordinates and
      // sends it to OpenAI's /v1/images/edits endpoint, which applies the
      // mask to the first image. Previously we burned a visible magenta
      // rectangle onto the photo; that was an unsupported convention and
      // the model sometimes preserved the rectangle as part of the design.

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
          shopImageUrl: photoDataUrl,
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

      <div className="mt-3 rounded-xl bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-900 leading-relaxed">
        <p className="font-semibold mb-1">Tips for the best result:</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>Landscape orientation, taken straight-on (not at an angle)</li>
          <li>Whole shopfront visible — fascia, windows, door, awning</li>
          <li>Good daylight, no people walking in front of the sign area</li>
          <li>Avoid heavy zoom — stand back rather than zooming in</li>
        </ul>
      </div>

      <div className="mt-2 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2 text-xs text-amber-900 leading-relaxed">
        <p className="font-semibold mb-1">No photo? Use Google Street View:</p>
        <ol className="list-decimal list-inside space-y-0.5">
          <li>Open Google Maps and find the building. Drag the orange "Street View" person onto the street outside it.</li>
          <li>Frame the shopfront cleanly in the window.</li>
          <li>Take a screenshot and save it:
            <ul className="list-disc list-inside ml-4 mt-0.5 space-y-0.5">
              <li><strong>Windows:</strong> press <kbd className="px-1 py-0.5 bg-white border border-amber-300 rounded text-[10px]">Win</kbd> + <kbd className="px-1 py-0.5 bg-white border border-amber-300 rounded text-[10px]">Shift</kbd> + <kbd className="px-1 py-0.5 bg-white border border-amber-300 rounded text-[10px]">S</kbd>, drag a box around the shopfront, then click the popup to save.</li>
              <li><strong>Mac:</strong> press <kbd className="px-1 py-0.5 bg-white border border-amber-300 rounded text-[10px]">⌘ Cmd</kbd> + <kbd className="px-1 py-0.5 bg-white border border-amber-300 rounded text-[10px]">Shift</kbd> + <kbd className="px-1 py-0.5 bg-white border border-amber-300 rounded text-[10px]">4</kbd>, drag a box around the shopfront. The screenshot saves to your Desktop.</li>
            </ul>
          </li>
          <li>Upload the saved file using the button below.</li>
        </ol>
      </div>

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

      <div className="mt-3 rounded-xl bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-900 leading-relaxed">
        <p className="font-semibold mb-1">Tips for the best result:</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>High-resolution PNG (the brand's official logo file is ideal)</li>
          <li>Transparent background &mdash; avoids weird outlines on the sign</li>
          <li>If the logo has both an icon and text, use the full lock-up</li>
          <li>Avoid screenshots from a website — quality is poor</li>
        </ul>
      </div>

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
    id: 'under_awning_lightbox',
    name: 'Under-Awning Lightbox',
    description: 'Illuminated lightbox hanging under an awning, projects perpendicular to the building',
    defaultSpec:
      'Slim-profile illuminated lightbox cabinet mounted to the underside of the awning or overhang, projecting perpendicular to the building face. Double-sided so the sign is visible from both directions of pedestrian traffic. White acrylic face with full-colour printed graphic, internal LED illumination, slim aluminium frame.',
  },
  {
    id: 'blade_sign',
    name: 'Blade Sign',
    description: 'Non-illuminated projecting sign mounted on a wall bracket',
    defaultSpec:
      'Double-sided blade sign projecting perpendicular from the building wall on a visible metal bracket arm. Non-illuminated painted or printed face. Classic proportions, visible from both directions along the street.',
  },
  {
    id: 'window_vinyl',
    name: 'Window Graphics',
    description: 'Printed, frosted or cut-out graphics applied directly to glass',
    defaultSpec:
      'Window graphics applied directly to the glass surface — frosted white vinyl with the logo and brand text reproduced in clear or contrasting colour. Should sit naturally on the glass and respect the existing window frame and mullions.',
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

      <div className="mt-3 rounded-xl bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-900 leading-relaxed">
        <p className="font-semibold mb-1">Choosing the right type:</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li><strong>Fascia panel</strong> &mdash; flat sign on the band above the entrance. Most common.</li>
          <li><strong>Dimensional letters</strong> &mdash; individual 3D letters mounted on the wall. Premium feel.</li>
          <li><strong>Lightbox</strong> &mdash; backlit cabinet mounted flat to the fascia. Good for night visibility.</li>
          <li><strong>Under-Awning Lightbox</strong> &mdash; illuminated lightbox hanging from the <em>underside</em> of an awning, projecting perpendicular to the shopfront. Double-sided, visible both directions along the street.</li>
          <li><strong>Blade sign</strong> &mdash; non-illuminated projecting sign on a <em>wall-mounted bracket arm</em>. Good when there's no awning or for a simpler look.</li>
          <li><strong>Window graphics</strong> &mdash; printed or frosted graphic applied to the glass. Best on shopfronts with large unobstructed windows.</li>
        </ul>
      </div>

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

      <div className="mt-3 rounded-xl bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-900 leading-relaxed">
        <p className="font-semibold mb-1">Drawing the sign zone:</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>Tap and drag to draw a rectangle where the sign should go</li>
          <li>Be deliberate about size &mdash; the AI uses your rectangle as the target</li>
          <li>For fascia panels, draw across the existing fascia band</li>
          <li>For window graphics, draw on the glass area</li>
          <li>You can clear and redraw if the position isn't quite right</li>
        </ul>
      </div>

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
