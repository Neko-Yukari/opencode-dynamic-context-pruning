// A failure this module authored. The adapter keeps the instance locally, so the
// class survives even when the host reports the failure later as a generic session
// error. Nothing here is recovered by parsing provider text, so a provider message
// that mimics this shape can never be mistaken for a guarded failure.
export type SummaryFailureKind = "image_budget"

export class SummaryFailure extends Error {
    readonly kind: SummaryFailureKind
    readonly safe: string

    constructor(kind: SummaryFailureKind, safe: string) {
        super(safe)
        this.name = "SummaryFailure"
        this.kind = kind
        this.safe = safe
    }
}
