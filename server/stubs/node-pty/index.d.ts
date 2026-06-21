export interface IPty {
  pid: number;
  process: string;
  resize(columns: number, rows: number): void;
  write(data: string): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface IPtyForkOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: { [key: string]: string | undefined };
}

export function spawn(file: string, args?: string[] | string, options?: IPtyForkOptions): IPty;
