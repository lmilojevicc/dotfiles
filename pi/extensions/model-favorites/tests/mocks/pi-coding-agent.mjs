export function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR;
}

const identity = (value) => value;
export function getSelectListTheme() {
	return {
		description: identity,
		noMatch: identity,
		scrollInfo: identity,
		selectedPrefix: identity,
		selectedText: identity,
	};
}

export function rawKeyHint(key, label) {
	return `${key} ${label}`;
}

export class ModelSelectorComponent {
	async loadModels() {}
	sortModels(models) { return models; }
	filterModels() {}
	updateList() {}
	handleInput(data) { this.originalInputs ??= []; this.originalInputs.push(data); }
}
