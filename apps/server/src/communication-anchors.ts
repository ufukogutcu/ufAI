import type Database from "better-sqlite3";

export function facingAnchorAngles(a: { x: number; y: number }, b: { x: number; y: number }) {
  const sourceAnchorAngle = (Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 360) % 360;
  return { sourceAnchorAngle, targetAnchorAngle: (sourceAnchorAngle + 180) % 360 };
}

export function migrateCommunicationAnchors(db: Database.Database) {
  db.exec(`ALTER TABLE communication_links ADD COLUMN sourceAnchorAngle REAL NOT NULL DEFAULT 0 CHECK(sourceAnchorAngle >= 0 AND sourceAnchorAngle < 360);
    ALTER TABLE communication_links ADD COLUMN targetAnchorAngle REAL NOT NULL DEFAULT 180 CHECK(targetAnchorAngle >= 0 AND targetAnchorAngle < 360);`);
  const update = db.prepare("UPDATE communication_links SET sourceAnchorAngle=?,targetAnchorAngle=? WHERE id=?");
  // Bounded keyset batches finish their reads before writing to the same table.
  const read = db.prepare(`SELECT l.id,a.x AS ax,a.y AS ay,b.x AS bx,b.y AS by
    FROM communication_links l JOIN agents a ON a.id=l.sourceAgentId JOIN agents b ON b.id=l.targetAgentId
    WHERE l.id > ? ORDER BY l.id LIMIT 100`);
  let cursor = "";
  while (true) {
    const rows = read.all(cursor) as { id: string; ax: number; ay: number; bx: number; by: number }[];
    if (!rows.length) break;
    for (const row of rows) {
      const angles = facingAnchorAngles({ x: row.ax, y: row.ay }, { x: row.bx, y: row.by });
      update.run(angles.sourceAnchorAngle, angles.targetAnchorAngle, row.id);
    }
    cursor = rows.at(-1)!.id;
  }
}
