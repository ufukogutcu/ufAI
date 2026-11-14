import mermaid from "mermaid";
import DOMPurify from "dompurify";
import type { DiagramEngine } from "./mermaid-service";

export const renderDiagram: DiagramEngine = async (source, palette, id, stageClass) => {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: 20000,
    maxEdges: 500,
    theme: "base",
    fontFamily: "Inter, sans-serif",
    secure: ["secure", "securityLevel", "startOnLoad", "htmlLabels", "theme", "themeCSS", "themeVariables", "fontFamily", "maxTextSize", "maxEdges", "flowchart"],
    flowchart: { htmlLabels: false },
    themeVariables: {
      background: palette.surface,
      primaryColor: palette.surface,
      secondaryColor: palette.surface,
      tertiaryColor: palette.surface,
      primaryTextColor: palette.text,
      secondaryTextColor: palette.text,
      tertiaryTextColor: palette.text,
      primaryBorderColor: palette.border,
      secondaryBorderColor: palette.border,
      tertiaryBorderColor: palette.border,
      lineColor: palette.line,
      textColor: palette.text,
      mainBkg: palette.surface,
      nodeBorder: palette.border,
      clusterBkg: palette.surface,
      clusterBorder: palette.border,
      edgeLabelBackground: palette.surface,
      actorBkg: palette.surface,
      actorBorder: palette.border,
      actorTextColor: palette.text,
      actorLineColor: palette.line,
      signalColor: palette.line,
      signalTextColor: palette.text,
      noteBkgColor: palette.surface,
      noteTextColor: palette.text,
      noteBorderColor: palette.border,
      labelBoxBkgColor: palette.surface,
      labelBoxBorderColor: palette.border,
      labelTextColor: palette.text,
      loopTextColor: palette.text,
      activationBkgColor: palette.surface,
      activationBorderColor: palette.border,
      titleColor: palette.text,
      fontFamily: "Inter, sans-serif",
    },
  });
  const stage = document.createElement("div");
  stage.className = stageClass;
  stage.setAttribute("aria-hidden", "true");
  document.body.append(stage);
  try {
    const result = await mermaid.render(id, source, stage);
    const clean = DOMPurify.sanitize(result.svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["foreignObject", "a", "image", "script", "animate", "animateMotion", "animateTransform", "set"],
    });
    const svg = new DOMParser().parseFromString(clean, "image/svg+xml").documentElement;
    const box = svg.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
    if (box?.length === 4 && box[2]! > 0 && box[3]! > 0) {
      if (box[2]! > 20000 || box[3]! > 20000) throw new Error("Diagram dimensions are too large to preview.");
      svg.setAttribute("width", String(Math.ceil(box[2]!)));
      svg.setAttribute("height", String(Math.ceil(box[3]!)));
    }
    return new XMLSerializer().serializeToString(svg);
  } finally {
    stage.remove();
  }
};
