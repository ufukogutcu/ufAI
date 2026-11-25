import { makerLabel } from "../model-catalog";
import { Field } from "./FormField";

const makerPrefix = "maker:";

export function ModelCompanyField({ makers, value, onChange }: {
  makers: (string | null)[];
  value: string | undefined;
  onChange: (maker: string | undefined) => void;
}) {
  return (
    <Field label="Model company">
      {(props) => (
        <select
          {...props}
          name="modelCompany"
          value={value === undefined ? "" : makerPrefix + value}
          onChange={(event) => onChange(event.target.value ? event.target.value.slice(makerPrefix.length) : undefined)}
        >
          <option value="">All companies</option>
          {makers.map((maker) => (
            <option key={maker ?? ""} value={makerPrefix + (maker ?? "")}>
              {makerLabel(maker)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
