import type { ContextLimitValue } from "./config"

const COMPONENT = /^(\d+(?:\.\d+)?)([kKmM%])?$/

function resolveComponent(component: string, contextTokens: number | undefined) {
    const match = COMPONENT.exec(component.trim())
    if (!match) return undefined

    const amount = Number(match[1])
    if (!Number.isFinite(amount) || amount < 0) return undefined

    switch (match[2]) {
        case undefined:
            return Math.round(amount)
        case "k":
        case "K":
            return Math.round(amount * 1_000)
        case "m":
        case "M":
            return Math.round(amount * 1_000_000)
        case "%": {
            if (contextTokens === undefined) return undefined
            const percent = Math.max(0, Math.min(100, amount))
            return Math.round((percent / 100) * contextTokens)
        }
        default:
            return undefined
    }
}

/** A threshold is one spec ("500k", "1m", "50%", "500000") or two joined by "/". */
export function isValidContextLimitSpec(value: string): boolean {
    const parts = value.split("/")
    if (parts.length === 0 || parts.length > 2) return false
    return parts.every((part) => COMPONENT.test(part.trim()))
}

/**
 * Resolve a configured threshold to tokens. Percentages need the model context
 * window; when a value carries two specs ("500k/50%") the lower resolved value
 * wins, so a setting never exceeds either bound.
 */
export function resolveContextLimit(
    value: ContextLimitValue | undefined,
    contextTokens: number | undefined,
): number | undefined {
    if (value === undefined) return undefined
    if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined

    const resolved = value
        .split("/")
        .map((part) => resolveComponent(part, contextTokens))
        .filter((token): token is number => token !== undefined)

    if (resolved.length === 0) return undefined
    return Math.min(...resolved)
}
