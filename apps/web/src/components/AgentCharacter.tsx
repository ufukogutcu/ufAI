import { memo, useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { CharacterVisibilityContext } from "./CharacterMotion";
import { activities, accessories, characterNames, colors, type Appearance, type Activity, type CharacterKind } from "../agent-appearance";
import styles from "./AgentCharacter.module.scss";

function Body({ kind }: { kind: CharacterKind }) {
  switch (kind) {
    case "pebble": return <path d="M63 154C59 124 74 91 98 80C125 65 155 68 168 95C183 127 191 166 166 179C142 191 91 188 73 176C66 172 64 165 63 154Z" />;
    case "sprout": return <><rect x="64" y="85" width="112" height="99" rx="30" /><path d="M120 85V64M120 69C91 72 91 44 104 49C119 50 122 61 120 69ZM120 69C121 45 145 43 146 53C146 65 130 71 120 69Z" /></>;
    case "bot": return <><path d="M120 78V59" fill="none" /><circle cx="120" cy="52" r="7" /><rect x="65" y="78" width="110" height="106" rx="29" /><rect className={styles.facePanel} x="78" y="101" width="84" height="47" rx="17" /></>;
    case "droplet": return <path d="M115 58C142 70 139 87 159 112C173 131 187 155 171 174C153 193 95 192 75 176C55 159 62 135 78 112C94 89 119 83 115 58Z" />;
  }
}

export const AgentCharacter = memo(function AgentCharacter({ appearance, activity = "idle", paused = false, decorative = false, className = "" }: {
  appearance: Appearance; activity?: Activity; paused?: boolean; decorative?: boolean; className?: string;
}) {
  const { kind, color, accessories: items } = appearance;
  const hidden = useContext(CharacterVisibilityContext);
  const element = useRef<SVGSVGElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const node = element.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? true));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const reading = activity === "studying" || activity === "studying-hard";
  return <svg ref={element} viewBox="0 0 240 240" className={`${styles.character} ${className}`}
    style={{ "--character-body": colors.find(item => item.id === color)!.variable } as CSSProperties}
    data-activity={activity} data-paused={paused || hidden || !visible} data-kind={kind}
    role={decorative ? undefined : "img"} aria-hidden={decorative || undefined}
    aria-label={decorative ? undefined : `${characterNames[kind]}, ${color}, ${activities.find(a => a.id === activity)!.name}${items.length ? `, wearing ${items.map(id => accessories.find(a => a.id === id)!.name).join(" and ")}` : ""}`}>
    <ellipse className={styles.shadow} cx="120" cy="207" rx="49" ry="7" />
    <g className={styles.actor}>
      <g className={styles.feet}><rect x="88" y="178" width="22" height="17" rx="8" /><rect x="134" y="178" width="22" height="17" rx="8" /></g>
      <g className={styles.body}><Body kind={kind} /></g>
      <g className={styles.face}>
        {activity === "dreaming" ? <g className={styles.closedEyes}><path d="M98 124Q104 130 110 124M131 124Q137 130 143 124" /></g> :
          <g className={styles.eyes}><ellipse cx="104" cy="124" rx={kind === "bot" ? 6 : 3.5} ry={kind === "bot" ? 2 : 4} /><ellipse cx="137" cy="124" rx={kind === "bot" ? 6 : 3.5} ry={kind === "bot" ? 2 : 4} /></g>}
        {activity === "studying-hard" && <path className={styles.brows} d="M97 113L110 117M131 117L144 113" />}
        {items.includes("glasses") && <g className={styles.glasses}><circle cx="104" cy="124" r="13" /><circle cx="137" cy="124" r="13" /><path d="M117 123Q120 120 124 123M85 122H91M150 122H156" /></g>}
      </g>
      {items.includes("headphones") && <g className={styles.headphones}><path d="M65 133V113C65 53 175 53 175 113V133" /><rect x="60" y="115" width="15" height="30" rx="7" /><rect x="165" y="115" width="15" height="30" rx="7" /></g>}
      {items.includes("cap") && <g className={styles.cap}><path d="M81 83Q84 49 117 51Q150 51 155 83Z" /><path d="M105 83H172Q180 91 167 94H105Z" /><path d="M118 57V76" fill="none" /></g>}
      {items.includes("badge") && <path className={styles.badge} d="M149 147L152 154L160 155L154 160L155 168L149 164L142 168L144 160L138 155L146 154Z" />}
      <g className={styles.leftHand}><circle cx={reading || activity === "working" ? 86 : 64} cy={reading ? 169 : activity === "working" ? 173 : 151} r="10" /></g>
      <g className={styles.rightHand}><circle cx={activity === "thinking" ? 131 : reading || activity === "working" ? 155 : 177} cy={activity === "thinking" ? 146 : reading ? 169 : activity === "working" ? 173 : 151} r="10" /></g>
      {activity === "working" && <g className={styles.laptop}>
        <path d="M84 158H158L167 193H76Z" /><path className={styles.paper} d="M69 193H175V198H69Z" />
        <path className={styles.screenLines} d="M103 169L97 174L104 179M139 169L145 174L138 179M126 166L117 182" />
      </g>}
      {reading && <g className={styles.book}>
        <path d="M120 168Q100 154 78 158V193Q101 190 120 203Q139 190 162 193V158Q140 154 120 168Z" />
        <path className={styles.paper} d="M120 171Q101 160 83 163V188Q103 187 120 198Q139 187 157 188V163Q140 160 120 171Z" />
        <path className={styles.bookLines} d="M120 171V198M90 172L110 178M90 180L110 186M130 178L150 172M130 186L150 180" />
        <path className={styles.page} d="M121 171Q137 161 155 163V186Q137 187 121 198Z" />
      </g>}
      {activity === "studying-hard" && <>
        <g className={styles.bookStack}><rect x="166" y="191" width="33" height="9" rx="2" /><rect className={styles.paper} x="170" y="181" width="34" height="9" rx="2" /><rect x="167" y="171" width="28" height="9" rx="2" /></g>
        <g className={styles.pencil}><path d="M155 157L170 133L175 136L160 160L154 164Z" /><path d="M155 157L160 160" /></g>
        <g className={styles.focusMarks}><path d="M53 93L45 86M51 105H40M184 93L192 85" /></g>
      </>}
    </g>
    {activity === "dreaming" && <g className={styles.dream}><circle cx="166" cy="76" r="3" /><circle cx="178" cy="63" r="5" /><path className={styles.dreamCloud} d="M183 46C168 40 176 22 187 26C191 11 211 14 213 26C230 20 237 44 222 48Z" /><path className={styles.dreamStar} d="M204 23L207 30L214 31L209 36L210 42L204 39L198 42L199 35L194 31L201 30Z" /></g>}
    {activity === "thinking" && <g className={styles.thoughts}><circle cx="175" cy="73" r="4" /><circle cx="190" cy="55" r="5" /><circle cx="210" cy="43" r="6" /></g>}
  </svg>;
});
