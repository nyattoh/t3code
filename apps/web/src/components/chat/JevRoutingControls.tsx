import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface JevRoutingConfiguration {
  readonly enabled: boolean;
  readonly taskSummary: string;
  readonly policy: string;
}

export function JevRoutingControls({
  configuration,
  selecting,
  dispatched,
  canCancel,
  result,
  onChange,
  onCancel,
}: {
  configuration: JevRoutingConfiguration;
  selecting: boolean;
  dispatched: boolean;
  canCancel: boolean;
  result: string | null;
  onChange: (configuration: JevRoutingConfiguration) => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={selecting}
          onClick={() => onChange({ ...configuration, enabled: !configuration.enabled })}
        >
          {configuration.enabled ? "Jev automatic" : "Manual model"}
        </Button>
        {selecting ? (
          <>
            <span role="status">
              {dispatched
                ? "Submitting turn; waiting for the server…"
                : "Selecting and preparing turn…"}
            </span>
            {canCancel ? (
              <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {configuration.enabled ? (
        <>
          <p>Use the selected Codex account. Your summary and preference are sent to TypeSafe.</p>
          <p>
            Each automatic send requests one Jev decision. Cancel stops the turn; an accepted
            decision request may still be billed.
          </p>
          <label className="block space-y-1">
            <span>Task summary</span>
            <Input
              value={configuration.taskSummary}
              maxLength={4000}
              disabled={selecting}
              placeholder="Describe the task without credentials or private code"
              onChange={(event) => onChange({ ...configuration, taskSummary: event.target.value })}
            />
          </label>
          <label className="block space-y-1">
            <span>Selection preference</span>
            <Input
              value={configuration.policy}
              maxLength={1000}
              disabled={selecting}
              placeholder="For example, prioritize quality"
              onChange={(event) => onChange({ ...configuration, policy: event.target.value })}
            />
          </label>
        </>
      ) : null}
      {result ? <p role="status">{result}</p> : null}
    </div>
  );
}
