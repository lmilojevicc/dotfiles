export type SgrMousePacket = {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
};

/** Parse one complete SGR mouse packet. */
export function parseSgrMousePacket(data: string): SgrMousePacket | null {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return null;
	return {
		code: Number(match[1]),
		col: Number(match[2]),
		row: Number(match[3]),
		final: match[4] as "M" | "m",
	};
}

/** Strip modifier and motion bits from an SGR button code. */
export function mouseBaseButton(code: number): number {
	return code & ~(4 | 8 | 16 | 32);
}
