import { useEffect, useId, useRef } from "react";
import { canRefractGlass, createGlassMap } from "../glass-geometry";
import styles from "./GlassMaterial.module.scss";

/** Decorative sibling of sharp, native controls. Put inside a glassSurface container. */
export function GlassMaterial({ refractive = true }: { refractive?: boolean }) {
  const id = `glass-${useId().replace(/:/g, "")}`;
  const material = useRef<HTMLSpanElement>(null);
  const lens = useRef<HTMLSpanElement>(null);
  const filter = useRef<SVGFilterElement>(null);
  const image = useRef<SVGFEImageElement>(null);
  useEffect(() => {
    const element = material.current!;
    const surface = lens.current!;
    const reduced = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const contrast = window.matchMedia("(prefers-contrast: more)");
    // SVG reference backdrop filters currently render reliably in Chromium.
    let frame = 0;
    let lastGeometry = "";
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!refractive || !canRefractGlass(navigator.userAgent, reduced.matches, contrast.matches)) {
          surface.style.removeProperty("backdrop-filter");
          element.dataset.refraction = "off";
          return;
        }
        const { width, height } = element.getBoundingClientRect();
        if (!width || !height) return;
        const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius);
        const geometry = `${width},${height},${radius}`;
        if (geometry !== lastGeometry) {
          const map = createGlassMap(width, height, radius);
          const canvas = document.createElement("canvas");
          canvas.width = map.width;
          canvas.height = map.height;
          const context = canvas.getContext("2d");
          if (!context) return;
          context.putImageData(new ImageData(map.data, map.width, map.height), 0, 0);
          image.current!.setAttribute("href", canvas.toDataURL());
          for (const target of [filter.current!, image.current!]) {
            target.setAttribute("width", String(width));
            target.setAttribute("height", String(height));
          }
          lastGeometry = geometry;
        }
        surface.style.backdropFilter = `url("#${id}") blur(0.5px) saturate(1.1)`;
        element.dataset.refraction = "on";
      });
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    reduced.addEventListener("change", update);
    contrast.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      reduced.removeEventListener("change", update);
      contrast.removeEventListener("change", update);
    };
  }, [id, refractive]);
  return (
    <span ref={material} className={styles.material} aria-hidden="true">
      <svg className={styles.definitions} width="0" height="0" focusable="false">
        <defs>
          <filter ref={filter} id={id} x="0" y="0" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feImage ref={image} x="0" y="0" preserveAspectRatio="none" result="map" />
            <feDisplacementMap in="SourceGraphic" in2="map" scale="18" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      <span ref={lens} className={styles.lens} />
      <span className={styles.reflection} />
    </span>
  );
}
