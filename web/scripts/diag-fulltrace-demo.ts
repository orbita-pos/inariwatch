import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const env = readFileSync(".env.local", "utf-8");
  const dbUrl = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m)![1];
  const sql = neon(dbUrl);

  console.log("\n[1] Org membership of demo + bernal:");
  const members = await sql`
    SELECT om.organization_id, u.email, om.role
    FROM organization_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.organization_id = 'f4b0ed46-aab2-4d2b-aa0d-e8c0ae37f5f7'
       OR u.email IN ('demo@inariwatch.com', 'bernal.rojas.dev@gmail.com')
  `;
  console.log(members);

  console.log("\n[2] Org owner:");
  const orgOwner = await sql`
    SELECT o.id, o.name, u.email AS owner_email
    FROM organizations o
    LEFT JOIN users u ON u.id = o.owner_id
    WHERE o.id = 'f4b0ed46-aab2-4d2b-aa0d-e8c0ae37f5f7'
  `;
  console.log(orgOwner);

  console.log("\n[3] Sembrado replay_session existe?");
  const ses = await sql`
    SELECT session_id, organization_id, project_id, started_at
    FROM replay_sessions
    WHERE session_id = 'fulltrace-demo-sess-001'
  `;
  console.log(ses);

  console.log("\n[4] Substrate recordings linked:");
  const recs = await sql`
    SELECT recording_id, session_id, project_id, event_count
    FROM substrate_recordings
    WHERE session_id = 'fulltrace-demo-sess-001'
  `;
  console.log(recs);

  console.log("\n[5] Alerts linked:");
  const al = await sql`
    SELECT id, session_id, project_id, title
    FROM alerts
    WHERE session_id = 'fulltrace-demo-sess-001'
  `;
  console.log(al);

  console.log("\n[6] Demo user id + access query simulation:");
  const demo = await sql`SELECT id FROM users WHERE email = 'demo@inariwatch.com'`;
  console.log("demo id:", demo);
  const demoId = demo[0].id;
  const access = await sql`
    SELECT o.id, o.owner_id, om.user_id AS member_user_id
    FROM organizations o
    LEFT JOIN organization_members om
      ON om.organization_id = o.id AND om.user_id = ${demoId}
    WHERE o.id = 'f4b0ed46-aab2-4d2b-aa0d-e8c0ae37f5f7'
      AND (o.owner_id = ${demoId} OR om.user_id = ${demoId})
  `;
  console.log("access query result:", access);
}
main().catch(e => { console.error(e); process.exit(1); });
