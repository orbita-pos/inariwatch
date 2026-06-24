// Fixture: Next.js app-router handler for /users (createUser).
// @ts-nocheck

export async function POST(req) {
  const body = await req.json()
  return Response.json(body, { status: 201 })
}
