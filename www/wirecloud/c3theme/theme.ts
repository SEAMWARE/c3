// c3theme - WireCloud in c³'s colours (see __init__.py). Built on defaulttheme, plus c3.scss on every view.
const parent: string | null = "defaulttheme";

export default {
    parent: parent,
    get_css: (_: string): string[] => ["css/c3.scss"],
    get_scripts: (_: string): string[] => []
};
