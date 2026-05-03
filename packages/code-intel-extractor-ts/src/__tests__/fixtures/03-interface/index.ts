export interface User {
  id: string;
  name: string;
  greet(): string;
}

export interface Admin extends User {
  permissions: string[];
}
