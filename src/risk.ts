export interface RiskRequest {
  from: string;
  to: string;
  amountCents: number;
  sourceBalanceCents: number;
}

export interface RiskVerdict {
  allow: boolean;
  reason?: string;
}

/** Screens a transfer before money moves. In production this calls an external service. */
export interface RiskCheck {
  assess(req: RiskRequest): Promise<RiskVerdict>;
}

/** Stand-in for the external service: always allows, but is asynchronous like the real call. */
export class DefaultRiskCheck implements RiskCheck {
  async assess(_req: RiskRequest): Promise<RiskVerdict> {
    await new Promise((resolve) => setImmediate(resolve));
    return { allow: true };
  }
}
