export type RsvpStatus = 'yes' | 'maybe' | 'no' | 'cheering'

export function useRsvpLabels() {
  const STATUS_LABELS: Record<RsvpStatus, string> = {
    yes: 'Going',
    maybe: 'Maybe',
    no: 'Not going',
    cheering: 'Cheering'
  }

  const STATUS_COLORS: Record<RsvpStatus, 'success' | 'warning' | 'neutral' | 'primary'> = {
    yes: 'success',
    maybe: 'warning',
    no: 'neutral',
    cheering: 'primary'
  }

  const STATUS_ICONS: Record<RsvpStatus, string> = {
    yes: 'i-lucide-check-circle-2',
    maybe: 'i-lucide-help-circle',
    no: 'i-lucide-x-circle',
    cheering: 'i-lucide-party-popper'
  }

  return { STATUS_LABELS, STATUS_COLORS, STATUS_ICONS }
}
