import { Component, lazy, memo, Suspense, type ReactNode } from "react";
import styles from "./RichText.module.scss";
export { RichTextProvider } from "./RichTextContext";

export interface RichTextProps {
  content: string;
  instanceId: string;
  streaming?: boolean;
}
const Renderer = lazy(() => import("./RichTextRenderer"));

class RenderingBoundary extends Component<{ content: string; children: ReactNode }, { content: string; failed: boolean }> {
  state = { content: this.props.content, failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props: { content: string }, state: { content: string }) {
    return props.content !== state.content ? { content: props.content, failed: false } : null;
  }
  render() {
    return this.state.failed ? <div className={styles.fallback}>{this.props.content}</div> : this.props.children;
  }
}

/** Loading or unexpected parser failures always leave the original message readable. */
export const RichText = memo(function RichText(props: RichTextProps) {
  return <RenderingBoundary content={props.content}>
    <Suspense fallback={<div className={styles.fallback}>{props.content}</div>}>
      <Renderer {...props} />
    </Suspense>
  </RenderingBoundary>;
});
