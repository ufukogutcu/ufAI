import type { CharacterKind } from "../agent-appearance";
import { accessories as wardrobe, type Accessory } from "../agent-appearance";
import s from "./WardrobeLayers.module.scss";

const star = "M0 -8L2.5 -3L8 -2L4 2L5 8L0 5L-5 8L-4 2L-8 -2L-2.5 -3Z";
export function WardrobeLayers({ items, kind, layer }: { items: Accessory[]; kind: CharacterKind; layer: "back" | "body" | "front" }) {
  const has = (id: Accessory) => items.includes(id);
  const headwear = wardrobe.some(item => item.slot === "head" && items.includes(item.id));
  if (layer === "back") return <g className={s.wardrobe}>
    {has("cape") && <g className={s.prop}><path d="M79 134Q120 119 161 134L185 190Q161 202 120 183Q79 202 55 190Z" /><path className={s.line} d="M79 149L70 182M161 149L170 182" /></g>}
    {has("wings") && <g className={s.paper}><path d="M77 155C31 157 28 102 47 108C22 72 54 69 81 122L91 150ZM163 155C209 157 212 102 193 108C218 72 186 69 159 122L149 150Z" /><path className={s.line} d="M50 116L79 143M190 116L161 143" /></g>}
    {has("backpack") && <g className={s.warm}><rect x="51" y="124" width="138" height="53" rx="16" /><path className={s.line} d="M57 142H73M167 142H183" /></g>}
    {has("battery") && <g className={s.prop}><path d="M166 158H183V180H166Z" /><rect x="180" y="150" width="27" height="38" rx="7" /><path d="M188 150V145H199V150" /><rect className={s.paper} x="185" y="157" width="17" height="24" rx="3" /><path className={s.line} d="M195 161L190 170H197L193 178" /></g>}
    {has("antenna-pack") && <g className={s.prop}><path d="M166 158H183V180H166Z" /><rect x="180" y="150" width="29" height="38" rx="8" /><path className={s.line} d="M201 150V108" /><circle className={s.warm} cx="201" cy="103" r="5" /><path className={s.line} d="M186 163Q194 156 202 163M190 169Q194 165 198 169" /><circle className={s.ink} cx="194" cy="176" r="2" /></g>}
  </g>;
  if (layer === "body") return <g className={s.wardrobe}>
    {has("vest") && <g className={s.prop}><path d="M78 141L101 147L120 168L139 147L162 141L171 177Q149 193 120 183Q91 193 69 177Z" /><path className={s.line} d="M120 168V183" /><rect className={s.paper} x="97" y="170" width="18" height="10" rx="3" /></g>}
    {has("scarf") && <g className={s.paper}><path d="M78 141Q120 153 162 141V151Q120 163 78 151Z" /><path d="M77 151L88 153L87 176L76 174Z" /><path className={s.line} d="M78 175V180M82 176V181M86 176V181" /></g>}
    {has("bowtie") && <g className={s.warm}><path d="M117 156Q97 141 98 155Q94 173 117 162M123 156Q143 141 142 155Q146 173 123 162" /><rect x="116" y="153" width="9" height="12" rx="3" /></g>}
    {has("pendant") && <g><path className={s.line} d="M80 140Q120 164 160 140" /><path className={s.warm} d="M120 153L127 163L120 174L113 163Z" /><path className={s.paper} d="M120 158L123 163L120 168L117 163Z" /></g>}
    {has("badge") && <path className={s.warm} transform="translate(151 170) scale(.9)" d={star} />}
    {has("stars") && <g className={s.warm}><path transform="translate(145 162) scale(.45)" d={star} /><path transform="translate(155 173) scale(.4)" d={star} /><path transform="translate(143 179) scale(.35)" d={star} /></g>}
    {has("circuits") && <g className={s.circuit}><path d="M147 181V163M147 173L157 166M147 169L140 163M147 179H158" /><circle cx="147" cy="161" r="2" /><circle cx="159" cy="164" r="2" /><circle cx="138" cy="161" r="2" /><circle cx="160" cy="179" r="2" /></g>}
  </g>;
  // Hat bands sit on the shared head center (x=120); stems and antennae must not shift them sideways.
  return <g className={s.wardrobe}>
    {has("beanie") && <g className={s.warm}><path d="M80 85Q80 48 120 48Q160 48 160 85Z" /><rect x="75" y="76" width="90" height="15" rx="6" /><circle cx="120" cy="43" r="10" /><path className={s.line} d="M94 58V75M111 53V75M129 53V75M146 58V75" /></g>}
    {has("wizard") && <g className={s.prop}><path d="M80 86L114 28Q120 22 131 32L154 54L134 57L160 86Z" /><path d="M61 89Q120 73 179 89Q187 102 165 102H75Q53 102 61 89Z" /><path className={s.warm} transform="translate(125 63) scale(.7)" d={star} /></g>}
    {has("bow") && <g className={s.warm} transform={`translate(${kind === "droplet" ? 145 : 119} ${kind === "sprout" ? 80 : 83})`}><path d="M-4 -2Q-28 -20 -24 -2Q-28 16 -4 4M4 -2Q28 -20 24 -2Q28 16 4 4" /><rect x="-5" y="-5" width="10" height="12" rx="3" /></g>}
    {has("crown") && <g className={s.warm}><path d="M90 85L84 63L105 74L120 59L135 74L156 63L150 85Z" /><circle cx="84" cy="61" r="3" /><circle cx="120" cy="57" r="3" /><circle cx="156" cy="61" r="3" /></g>}
    {has("headband") && <g className={s.prop}><path d="M74 86Q120 75 166 86V99Q120 88 74 99Z" /><path className={s.lightLine} d="M119 93V82L128 87L119 89L128 94M87 89H98M142 89H153" /></g>}
    {has("visor") && <g><rect className={s.glass} x="86" y="110" width="68" height="28" rx="11" /><rect className={s.line} x="83" y="107" width="74" height="34" rx="13" /><path className={s.lightLine} d="M89 115H112" /></g>}
    {has("earmuffs") && <g className={s.paper}><path className={s.band} d={headwear ? "M64 127V110Q64 102 76 102M164 102Q176 102 176 110V127" : "M64 127V111C64 58 176 58 176 111V127"} /><rect x="53" y="114" width="23" height="32" rx="11" /><rect x="164" y="114" width="23" height="32" rx="11" /></g>}
    {has("communicator") && <g className={s.prop}><path className={s.line} d={headwear ? "M65 125V110Q65 103 76 103" : "M65 125V109Q64 82 88 81"} /><rect x="52" y="111" width="24" height="31" rx="10" /><rect className={s.warm} x="59" y="117" width="10" height="19" rx="5" /><path className={s.line} d="M64 143V151Q65 161 85 159" /><rect className={s.ink} x="81" y="155" width="12" height="6" rx="3" /></g>}
  </g>;
}
