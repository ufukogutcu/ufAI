import {
  Children,
  cloneElement,
  useState,
  type DetailsHTMLAttributes,
  type ReactElement,
} from "react";
import { Appearance } from "./Appearance";

// Native details retains focus, refs, and mounted fields when closed. One content
// group enters on opening, rather than animating each field independently.
export function Disclosure({ children }: {
  children: ReactElement<DetailsHTMLAttributes<HTMLDetailsElement>, "details">;
}) {
  const [open, setOpen] = useState(!!children.props.open);
  const [summary, ...content] = Children.toArray(children.props.children);
  return cloneElement(children, {
    onToggle(event) {
      children.props.onToggle?.(event);
      setOpen(event.currentTarget.open);
    },
    children: (
      <>
        {summary}
        <Appearance trigger={open}>
          <div>{content}</div>
        </Appearance>
      </>
    ),
  });
}
