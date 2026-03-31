export type Tool = {
    name: string;
    id: string;
    detected: boolean;
    version?: string;
};
export declare function detectTools(): Tool[];
