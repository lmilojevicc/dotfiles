function optional(schema) {
	return { ...schema, __optional: true };
}

export const Type = {
	String(options = {}) { return { type: "string", ...options }; },
	Integer(options = {}) { return { type: "integer", ...options }; },
	Optional: optional,
	Object(properties, options = {}) {
		const required = Object.entries(properties).filter(([, value]) => !value.__optional).map(([key]) => key);
		const normalized = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
			const { __optional, ...schema } = value;
			return [key, schema];
		}));
		return { type: "object", properties: normalized, required, ...options };
	},
};
