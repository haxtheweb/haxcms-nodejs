// the base line build that's used to setup everything in a production environment
import "./build.js";
import "./app.js";
import "./build-home.js";
import "./build-install.js";
import "./build-haxcms.js";
// we build elmsln dependency trees from here since there's so much overlap.
import "./build-elmsln.js";
// important in smaller builds
import "../node_modules/@haxtheweb/baseline-build-hax/baseline-build-hax.js";
window.process = {
  env: {
    NODE_ENV: 'production'
  }
};
// just make it work
import "../node_modules/web-dialog/index.js";
// supported backends
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/backends/haxcms-backend-beaker.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/backends/haxcms-backend-demo.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/backends/haxcms-backend-php.js";
// core HAXcms
import "../node_modules/@haxtheweb/haxcms-elements/haxcms-elements.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/haxcms-editor-builder.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/haxcms-outline-editor-dialog.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/haxcms-site-builder.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/haxcms-site-editor-ui.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/haxcms-site-editor.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/haxcms-site-router.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/haxcms-site-store.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/HAXCMSThemeWiring.js";

// pieces of UI
import "../node_modules/@haxtheweb/haxcms-elements/lib/ui-components/active-item/site-active-title.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/ui-components/blocks/site-children-block.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/ui-components/navigation/site-breadcrumb.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/ui-components/navigation/site-menu-button.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/ui-components/navigation/site-menu.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/ui-components/navigation/site-top-menu.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/ui-components/query/site-render-query.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/ui-components/query/site-query.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/ui-components/query/site-query-menu-slice.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/ui-components/site/site-rss-button.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/ui-components/site/site-title.js";

// themes are dynamically imported and without directly being mentioned
import "../node_modules/@haxtheweb/haxcms-elements/lib/development/haxcms-dev-theme.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/development/haxcms-theme-developer.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/themes/haxcms-slide-theme.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/themes/haxcms-minimalist-theme.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/themes/haxcms-basic-theme.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/themes/haxcms-custom-theme.js";
import "../node_modules/@haxtheweb/haxcms-elements/lib/core/themes/haxcms-user-theme.js";
import "../node_modules/@haxtheweb/outline-player/outline-player.js";
import "../node_modules/@haxtheweb/simple-blog/simple-blog.js";
import "../node_modules/@haxtheweb/learn-two-theme/learn-two-theme.js";
import "../node_modules/@haxtheweb/haxor-slevin/haxor-slevin.js";

// these should all be dynamically imported as well
import "../node_modules/@haxtheweb/voice-recorder/voice-recorder.js";
import "../node_modules/@haxtheweb/h5p-element/h5p-element.js";
import "../node_modules/@haxtheweb/hax-logo/hax-logo.js";
import "../node_modules/@haxtheweb/a11y-gif-player/a11y-gif-player.js";
import "../node_modules/@haxtheweb/citation-element/citation-element.js";
import "../node_modules/@haxtheweb/image-compare-slider/image-compare-slider.js";
import "../node_modules/@haxtheweb/license-element/license-element.js";
import "../node_modules/@haxtheweb/lrn-math/lrn-math.js";
import "../node_modules/@haxtheweb/lrn-table/lrn-table.js";
import "../node_modules/@haxtheweb/lrn-vocab/lrn-vocab.js";
import "../node_modules/@haxtheweb/md-block/md-block.js";
import "../node_modules/@haxtheweb/media-behaviors/media-behaviors.js";
import "../node_modules/@haxtheweb/media-image/media-image.js";
import "../node_modules/@haxtheweb/meme-maker/meme-maker.js";
import "../node_modules/@haxtheweb/multiple-choice/multiple-choice.js";
import "../node_modules/@haxtheweb/person-testimonial/person-testimonial.js";
import "../node_modules/@haxtheweb/place-holder/place-holder.js";
import "../node_modules/@haxtheweb/q-r/q-r.js";
import "../node_modules/@haxtheweb/full-width-image/full-width-image.js";
import "../node_modules/@haxtheweb/self-check/self-check.js";
import "../node_modules/@haxtheweb/stop-note/stop-note.js";
import "../node_modules/@haxtheweb/video-player/video-player.js";
import "../node_modules/@haxtheweb/wikipedia-query/wikipedia-query.js";
import "../node_modules/@haxtheweb/lrndesign-timeline/lrndesign-timeline.js";
import "../node_modules/@haxtheweb/html-block/html-block.js";
import "../node_modules/@haxtheweb/user-action/user-action.js";
import "../node_modules/@haxtheweb/grid-plate/grid-plate.js";