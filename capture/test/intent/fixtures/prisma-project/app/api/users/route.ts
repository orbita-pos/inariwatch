// Fixture: Next.js handler that uses Prisma. The intent compiler walks
// up from this file to find prisma/schema.prisma at the project root.
//
// @ts-nocheck

export async function POST(req) {
  const body = await req.json()
  return Response.json(body, { status: 201 })
}

export async function getUser(req) {
  const id = req.url.split("/").pop()
  return Response.json({ id })
}
