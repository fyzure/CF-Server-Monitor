const TOOLTIP_MAX_WIDTH = 180
const VIEWPORT_PADDING = 12

export function updateThreeNetTooltipPosition(event) {
  const target = event.currentTarget

  if (!(target instanceof HTMLElement)) {
    return
  }

  const viewportWidth = document.documentElement.clientWidth || window.innerWidth
  const tooltipWidth = Math.min(TOOLTIP_MAX_WIDTH, Math.max(0, viewportWidth - VIEWPORT_PADDING * 2))
  const rect = target.getBoundingClientRect()
  const center = rect.left + rect.width / 2
  const minCenter = VIEWPORT_PADDING + tooltipWidth / 2
  const maxCenter = viewportWidth - VIEWPORT_PADDING - tooltipWidth / 2
  const clampedCenter = Math.min(Math.max(center, minCenter), maxCenter)

  target.style.setProperty('--three-net-tooltip-shift', `${Math.round(clampedCenter - center)}px`)
}
