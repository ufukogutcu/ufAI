import { lazy, Suspense, type ComponentProps } from "react";
import { LoadingState } from "./Feedback";

const Fields = lazy(() => import("./ModelConfigurationFields"));

export function ModelConfigurationFields(props: ComponentProps<typeof Fields>) {
  return <Suspense fallback={<LoadingState>Loading model settings…</LoadingState>}>
    <Fields {...props} />
  </Suspense>;
}
