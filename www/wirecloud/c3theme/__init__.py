# c3theme - WireCloud in c³'s colours: dark, c³'s pink as the brand colour. Built on defaulttheme.
# The sources are static/css/_variables.scss (c³'s palette mapped onto WireCloud's variables) and static/css/c3.scss
# (rules of c³'s own); tools/wirecloud-theme.sh compiles them with WireCloud's build into static/css/c3theme_*.css.
from wirecloud.translation import gettext_lazy as _

parent = "defaulttheme"
label = _("c³")
