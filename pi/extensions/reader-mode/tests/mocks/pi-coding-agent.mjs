export const VERSION = "0.85.1";

export class InteractiveMode {
	constructor(version = VERSION) {
		this.version = version;
	}

	async init() {}

	mountInteractiveTui(tui, components) {
		for (const component of components) tui.addChild(component);
		if (tui.viewport) tui.setLayoutRoot(this.fullscreenLayoutRoot);
	}

	switchTuiMode() {}
}
