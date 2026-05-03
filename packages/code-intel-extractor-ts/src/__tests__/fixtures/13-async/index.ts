/**
 * Fetch the first user.
 * @throws {NotFoundError}
 */
export async function fetchFirstUser(): Promise<{ id: string }> {
  return { id: "u-1" };
}

export class API {
  async list(): Promise<string[]> {
    return [];
  }
}
