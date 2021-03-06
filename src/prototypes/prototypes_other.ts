String.prototype.padRight = function (length: number, char = ' '): string {
	return this + char.repeat(Math.max(length - this.length, 0));
};

String.prototype.padLeft = function (length: number, char = ' '): string {
	return char.repeat(Math.max(length - this.length, 0)) + this;
};

Number.prototype.toPercent = function (decimals = 0): string {
	return (this * 100).toFixed(decimals) + '%';
};