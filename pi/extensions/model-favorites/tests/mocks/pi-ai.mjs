export function modelsAreEqual(left, right) {
	return !!left && !!right && left.provider === right.provider && left.id === right.id;
}
