<?php
/**
 * BitPype Connector — design editing (plugin v2, capability
 * "design1").
 *
 * Ely's model, enforced in code: the design chat in the BitPype
 * portal may only ever PROPOSE changes. A proposal changes nothing
 * here until the owner approves it in the portal; approval is
 * delivered to this plugin on its sync cycle, the plugin snapshots
 * the current design state BEFORE applying, and an approved undo
 * restores that snapshot byte-for-byte.
 *
 * The edit surface is exactly two layers, defined by a fixed op
 * vocabulary that mirrors the platform's (server/wpDesignOps.js):
 *   Layer 1 — global look: named color/font/scale tokens compiled
 *             into a plugin-owned CSS layer printed last in <head>.
 *   Layer 2 — BitPype zones: banner / hero / CTA sections this
 *             plugin renders from structured fields.
 * There is NO op for raw CSS, theme files, other plugins, or page
 * content, and this file refuses — on its own, independent of the
 * platform — any op outside the vocabulary.
 *
 * A staged proposal can be rendered for the owner only, via a
 * short-lived preview token the platform validates per request
 * (?bitpype_preview=…). Public visitors never see staged state:
 * without a valid token the parameter is ignored entirely.
 *
 * @package BitpypeConnector
 */

if (! defined('ABSPATH')) {
	exit;
}

// ---------------------------------------------------------------------
// Vocabulary (mirror of the platform's — keep the two in step)
// ---------------------------------------------------------------------

function bitpype_design_color_tokens() {
	return array(
		'primary_color', 'secondary_color', 'accent_color', 'background_color',
		'surface_color', 'text_color', 'muted_text_color', 'link_color',
		'button_background', 'button_text_color', 'header_background', 'footer_background',
	);
}

function bitpype_design_font_tokens() {
	return array('heading_font', 'body_font');
}

function bitpype_design_font_stacks() {
	return array(
		'system_sans'  => "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
		'system_serif' => "Georgia, 'Times New Roman', serif",
		'georgia'      => "Georgia, 'Times New Roman', serif",
		'aria'         => 'Arial, Helvetica, sans-serif',
		'helvetica'    => "'Helvetica Neue', Helvetica, Arial, sans-serif",
		'verdana'      => 'Verdana, Geneva, sans-serif',
		'trebuchet'    => "'Trebuchet MS', 'Lucida Grande', sans-serif",
		'times'        => "'Times New Roman', Times, serif",
		'courier'      => "'Courier New', Courier, monospace",
		'inter'        => "'Inter', sans-serif",
		'roboto'       => "'Roboto', sans-serif",
		'open_sans'    => "'Open Sans', sans-serif",
		'lato'         => "'Lato', sans-serif",
		'montserrat'   => "'Montserrat', sans-serif",
		'poppins'      => "'Poppins', sans-serif",
		'nunito'       => "'Nunito', sans-serif",
		'merriweather' => "'Merriweather', serif",
		'playfair'     => "'Playfair Display', serif",
		'source_sans'  => "'Source Sans 3', sans-serif",
	);
}

function bitpype_design_google_fonts() {
	return array(
		'inter' => 'Inter', 'roboto' => 'Roboto', 'open_sans' => 'Open Sans',
		'lato' => 'Lato', 'montserrat' => 'Montserrat', 'poppins' => 'Poppins',
		'nunito' => 'Nunito', 'merriweather' => 'Merriweather',
		'playfair' => 'Playfair Display', 'source_sans' => 'Source Sans 3',
	);
}

function bitpype_design_scale_tokens() {
	return array(
		'base_font_size' => array(14, 20),
		'border_radius'  => array(0, 24),
	);
}

function bitpype_design_all_tokens() {
	return array_merge(
		bitpype_design_color_tokens(),
		bitpype_design_font_tokens(),
		array_keys(bitpype_design_scale_tokens())
	);
}

// ---------------------------------------------------------------------
// State (all of it lives in options owned by this plugin)
// ---------------------------------------------------------------------

function bitpype_design_state() {
	$state = get_option('bitpype_design_state', null);
	if (! is_array($state)) {
		$state = array('version' => 0, 'tokens' => array(), 'zones' => array(), 'css' => '');
	}
	$state['tokens'] = isset($state['tokens']) && is_array($state['tokens']) ? $state['tokens'] : array();
	$state['zones']  = isset($state['zones']) && is_array($state['zones']) ? $state['zones'] : array();
	$state['css']    = isset($state['css']) ? (string) $state['css'] : '';
	$state['version'] = isset($state['version']) ? (int) $state['version'] : 0;
	return $state;
}

function bitpype_design_log($action, $summary) {
	$log = get_option('bitpype_design_log', array());
	if (! is_array($log)) {
		$log = array();
	}
	$log[] = array('at' => time(), 'action' => (string) $action, 'summary' => (string) $summary);
	$log = array_slice($log, -50);
	update_option('bitpype_design_log', $log);
}

/**
 * Compile tokens into the Layer 1 CSS (mirror of the platform
 * compiler; used only if a state ever lacks its compiled CSS —
 * sync payloads normally carry the platform-compiled bytes).
 *
 * @param array $tokens Token state.
 * @return string
 */
function bitpype_design_compile_css($tokens) {
	$vars_map = array(
		'primary_color' => '--bp-primary', 'secondary_color' => '--bp-secondary',
		'accent_color' => '--bp-accent', 'background_color' => '--bp-bg',
		'surface_color' => '--bp-surface', 'text_color' => '--bp-text',
		'muted_text_color' => '--bp-muted', 'link_color' => '--bp-link',
		'button_background' => '--bp-btn-bg', 'button_text_color' => '--bp-btn-text',
		'header_background' => '--bp-header-bg', 'footer_background' => '--bp-footer-bg',
	);
	$stacks = bitpype_design_font_stacks();
	$vars   = array();
	$rules  = array();
	foreach (bitpype_design_color_tokens() as $token) {
		if (! empty($tokens[$token])) {
			$vars[] = $vars_map[$token] . ':' . $tokens[$token] . ';';
		}
	}
	if (! empty($tokens['base_font_size'])) {
		$vars[] = '--bp-font-size:' . (int) $tokens['base_font_size'] . 'px;';
	}
	if (isset($tokens['border_radius']) && '' !== $tokens['border_radius']) {
		$vars[] = '--bp-radius:' . (int) $tokens['border_radius'] . 'px;';
	}
	if ($vars) {
		$rules[] = ':root{' . implode('', $vars) . '}';
	}
	if (! empty($tokens['background_color'])) {
		$rules[] = 'body{background-color:' . $tokens['background_color'] . ';}';
	}
	if (! empty($tokens['text_color'])) {
		$rules[] = 'body{color:' . $tokens['text_color'] . ';}';
	}
	if (! empty($tokens['body_font']) && isset($stacks[$tokens['body_font']])) {
		$rules[] = 'body{font-family:' . $stacks[$tokens['body_font']] . ';}';
	}
	if (! empty($tokens['base_font_size'])) {
		$rules[] = 'body{font-size:' . (int) $tokens['base_font_size'] . 'px;}';
	}
	if (! empty($tokens['heading_font']) && isset($stacks[$tokens['heading_font']])) {
		$rules[] = 'h1,h2,h3,h4,h5,h6{font-family:' . $stacks[$tokens['heading_font']] . ';}';
	}
	if (! empty($tokens['primary_color'])) {
		$rules[] = 'h1,h2,h3{color:' . $tokens['primary_color'] . ';}';
	}
	if (! empty($tokens['link_color'])) {
		$rules[] = 'a{color:' . $tokens['link_color'] . ';}';
	}
	if (! empty($tokens['muted_text_color'])) {
		$rules[] = '.has-text-color.has-secondary-color,figcaption,.wp-block-post-date{color:' . $tokens['muted_text_color'] . ';}';
	}
	if (! empty($tokens['header_background'])) {
		$rules[] = 'header.wp-block-template-part,.site-header,header#masthead{background-color:' . $tokens['header_background'] . ';}';
	}
	if (! empty($tokens['footer_background'])) {
		$rules[] = 'footer.wp-block-template-part,.site-footer,footer#colophon{background-color:' . $tokens['footer_background'] . ';}';
	}
	if (! empty($tokens['button_background']) || ! empty($tokens['button_text_color']) || isset($tokens['border_radius'])) {
		$bits = array();
		if (! empty($tokens['button_background'])) {
			$bits[] = 'background-color:' . $tokens['button_background'] . ';';
		}
		if (! empty($tokens['button_text_color'])) {
			$bits[] = 'color:' . $tokens['button_text_color'] . ';';
		}
		if (isset($tokens['border_radius']) && '' !== $tokens['border_radius']) {
			$bits[] = 'border-radius:' . (int) $tokens['border_radius'] . 'px;';
		}
		if ($bits) {
			$rules[] = 'button,input[type="submit"],input[type="button"],.button,.wp-block-button__link,a.wp-block-button__link{' . implode('', $bits) . '}';
		}
	}
	if (! empty($tokens['surface_color'])) {
		$rules[] = '.card,.wp-block-group.has-background{background-color:' . $tokens['surface_color'] . ';}';
	}
	if (! empty($tokens['accent_color'])) {
		$rules[] = '::selection{background-color:' . $tokens['accent_color'] . ';}';
	}
	return implode("\n", $rules);
}

// ---------------------------------------------------------------------
// Op validation — the plugin's own second layer of refusal
// ---------------------------------------------------------------------

function bitpype_design_valid_color($value) {
	if (! is_string($value)) {
		return null;
	}
	$s = strtolower(trim($value));
	if (! preg_match('/^#([0-9a-f]{3}|[0-9a-f]{6})$/', $s, $m)) {
		return null;
	}
	$hex = $m[1];
	if (3 === strlen($hex)) {
		$hex = $hex[0] . $hex[0] . $hex[1] . $hex[1] . $hex[2] . $hex[2];
	}
	return '#' . $hex;
}

function bitpype_design_validate_zone_fields($fields, $partial) {
	if (! is_array($fields)) {
		return 'zone fields missing';
	}
	$allowed = array('headline', 'subtext', 'button_text', 'button_url', 'accent', 'align');
	foreach (array_keys($fields) as $key) {
		if (! in_array($key, $allowed, true)) {
			return 'unknown zone field: ' . $key;
		}
	}
	foreach (array('headline', 'subtext', 'button_text') as $text_key) {
		if (isset($fields[$text_key])) {
			$v = (string) $fields[$text_key];
			if (preg_match('/[<>{}]/', $v)) {
				return 'zone text contains markup characters';
			}
			$max = 'headline' === $text_key ? 120 : ('subtext' === $text_key ? 300 : 40);
			if (strlen($v) > $max) {
				return 'zone text too long: ' . $text_key;
			}
		} elseif (! $partial && 'headline' === $text_key) {
			return 'zone headline is required';
		}
	}
	if (isset($fields['button_url']) && '' !== (string) $fields['button_url']) {
		$url = (string) $fields['button_url'];
		if (! preg_match('#^https?://#i', $url) || preg_match('/[<>"\'\s]/', $url)) {
			return 'zone button_url must be a valid http(s) URL';
		}
	}
	if (isset($fields['accent']) && ! in_array($fields['accent'], array('primary', 'dark', 'light'), true)) {
		return 'unknown zone accent';
	}
	if (isset($fields['align']) && ! in_array($fields['align'], array('left', 'center'), true)) {
		return 'unknown zone align';
	}
	return null;
}

/**
 * Validate a whole op list against the vocabulary and the current
 * zones. Returns null when every op is legal, else the reason.
 * This runs on sync payloads the PLATFORM already validated — a
 * failure here means the payload was not produced by the design
 * chat, and the whole proposal is refused.
 *
 * @param mixed $ops    Op list from the sync payload.
 * @param array $zones  Current zones.
 * @return string|null
 */
function bitpype_design_validate_ops($ops, $zones) {
	if (! is_array($ops) || empty($ops) || count($ops) > 24) {
		return 'op list missing or out of bounds';
	}
	$stacks = bitpype_design_font_stacks();
	$scales = bitpype_design_scale_tokens();
	foreach ($ops as $op) {
		if (! is_array($op) || empty($op['type'])) {
			return 'malformed op';
		}
		if ('set_token' === $op['type'] || 'remove_token' === $op['type']) {
			$token = isset($op['token']) ? (string) $op['token'] : '';
			if (! in_array($token, bitpype_design_all_tokens(), true)) {
				return 'unknown design token: ' . $token;
			}
			if ('set_token' === $op['type']) {
				if (in_array($token, bitpype_design_color_tokens(), true)) {
					if (null === bitpype_design_valid_color(isset($op['value']) ? $op['value'] : null)) {
						return 'bad color value for ' . $token;
					}
				} elseif (in_array($token, bitpype_design_font_tokens(), true)) {
					if (! isset($stacks[(string) (isset($op['value']) ? $op['value'] : '')])) {
						return 'bad font value for ' . $token;
					}
				} elseif (isset($scales[$token])) {
					$v = isset($op['value']) ? $op['value'] : null;
					if (! is_numeric($v) || (int) $v != $v || (int) $v < $scales[$token][0] || (int) $v > $scales[$token][1]) {
						return 'bad scale value for ' . $token;
					}
				}
			}
		} elseif ('zone_create' === $op['type']) {
			$zone = isset($op['zone']) && is_array($op['zone']) ? $op['zone'] : array();
			$id   = isset($zone['id']) ? (string) $zone['id'] : '';
			if (! preg_match('/^[a-z0-9][a-z0-9-]{1,40}$/', $id)) {
				return 'bad zone id';
			}
			if (isset($zones[$id])) {
				return 'zone already exists: ' . $id;
			}
			if (! in_array(isset($zone['type']) ? $zone['type'] : '', array('banner', 'hero', 'cta'), true)) {
				return 'bad zone type';
			}
			$err = bitpype_design_validate_zone_fields(isset($zone['fields']) ? $zone['fields'] : null, false);
			if (null !== $err) {
				return $err;
			}
		} elseif ('zone_update' === $op['type'] || 'zone_remove' === $op['type']) {
			$id = isset($op['zoneId']) ? (string) $op['zoneId'] : '';
			if (! isset($zones[$id])) {
				return 'zone does not exist: ' . $id;
			}
			if ('zone_update' === $op['type']) {
				$err = bitpype_design_validate_zone_fields(isset($op['fields']) ? $op['fields'] : null, true);
				if (null !== $err) {
					return $err;
				}
			}
		} else {
			return 'unknown change type: ' . (string) $op['type'];
		}
	}
	return null;
}

// ---------------------------------------------------------------------
// Census — the site map the design chat plans from
// ---------------------------------------------------------------------

function bitpype_design_detect_builder($post) {
	if ('builder' === (string) get_post_meta($post->ID, '_elementor_edit_mode', true)) {
		return 'elementor';
	}
	$content = (string) $post->post_content;
	if ('on' === (string) get_post_meta($post->ID, '_et_pb_use_builder', true) || false !== strpos($content, 'et_pb_')) {
		return 'divi';
	}
	if (false !== strpos($content, '<!-- wp:')) {
		return 'gutenberg';
	}
	if (false !== strpos($content, 'vc_row')) {
		return 'other';
	}
	return 'none';
}

function bitpype_connector_build_census() {
	global $wp_version;
	$theme  = wp_get_theme();
	$logo   = '';
	$logo_id = (int) get_theme_mod('custom_logo', 0);
	if ($logo_id > 0) {
		$logo = (string) wp_get_attachment_image_url($logo_id, 'full');
	}
	$pages = array();
	foreach (get_pages(array('post_status' => 'publish', 'number' => 120, 'sort_column' => 'menu_order,post_title')) as $page) {
		$pages[] = array(
			'id'      => (int) $page->ID,
			'title'   => (string) $page->post_title,
			'url'     => (string) get_permalink($page),
			'builder' => bitpype_design_detect_builder($page),
		);
	}
	$locations = get_nav_menu_locations();
	$by_menu   = array();
	foreach ((array) $locations as $loc => $menu_id) {
		$by_menu[(int) $menu_id][] = (string) $loc;
	}
	$menus = array();
	foreach ((array) wp_get_nav_menus() as $menu) {
		$menus[] = array(
			'name'      => (string) $menu->name,
			'locations' => isset($by_menu[(int) $menu->term_id]) ? $by_menu[(int) $menu->term_id] : array(),
		);
	}
	$state = bitpype_design_state();
	return array(
		'wp_version'   => (string) $wp_version,
		'generated_by' => 'bitpype-connector/' . BITPYPE_CONNECTOR_VERSION,
		'theme'        => array(
			'name'       => (string) $theme->get('Name'),
			'version'    => (string) $theme->get('Version'),
			'stylesheet' => (string) get_stylesheet(),
		),
		'site'         => array(
			'title'    => (string) get_bloginfo('name'),
			'tagline'  => (string) get_bloginfo('description'),
			'logo_url' => $logo,
			'timezone' => (string) get_option('timezone_string', ''),
			'home_url' => (string) home_url(),
		),
		'pages'        => $pages,
		'menus'        => $menus,
		'design'       => array(
			'version' => (int) $state['version'],
			'tokens'  => (object) $state['tokens'],
			'zones'   => (object) $state['zones'],
		),
	);
}

function bitpype_connector_push_census() {
	if ('' === bitpype_connector_site_key()) {
		return false;
	}
	$result = bitpype_connector_request(
		'POST',
		'/design/census',
		array_merge(
			array('census' => bitpype_connector_build_census()),
			bitpype_connector_plugin_info()
		),
		true
	);
	if ('SITE_REVOKED' === $result['error_code'] || 410 === $result['code']) {
		update_option('bitpype_connector_status', 'revoked');
		return false;
	}
	if (200 === $result['code']) {
		update_option('bitpype_census_sent_at', time());
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------
// Sync — pull approved work, snapshot, apply, report
// ---------------------------------------------------------------------

function bitpype_design_snapshot($proposal_id, $state) {
	$snaps = get_option('bitpype_design_snapshots', array());
	if (! is_array($snaps)) {
		$snaps = array();
	}
	$snaps[(string) $proposal_id] = array('state' => $state, 'at' => time());
	$snaps = array_slice($snaps, -10, null, true);
	update_option('bitpype_design_snapshots', $snaps);
}

function bitpype_connector_design_sync() {
	if ('' === bitpype_connector_site_key() || 'connected' !== bitpype_connector_status()) {
		return;
	}
	$result = bitpype_connector_request('GET', '/design/sync', null, true);
	if ('SITE_REVOKED' === $result['error_code'] || 410 === $result['code']) {
		update_option('bitpype_connector_status', 'revoked');
		return;
	}
	if (200 !== $result['code'] || empty($result['data']['data'])) {
		return;
	}
	$data    = $result['data']['data'];
	$reports = array();
	$changed = false;

	foreach ((isset($data['apply']) && is_array($data['apply'])) ? $data['apply'] : array() as $job) {
		$pid    = isset($job['proposal_id']) ? (int) $job['proposal_id'] : 0;
		$state  = bitpype_design_state();
		$err    = bitpype_design_validate_ops(isset($job['ops']) ? $job['ops'] : null, $state['zones']);
		if (null !== $err) {
			$reports[] = array('proposal_id' => $pid, 'action' => 'apply', 'ok' => false, 'error' => 'Refused by the plugin: ' . $err);
			bitpype_design_log('apply_refused', 'Proposal #' . $pid . ' refused: ' . $err);
			continue;
		}
		bitpype_design_snapshot($pid, $state);
		$new_state = array(
			'version' => ((int) $state['version']) + 1,
			'tokens'  => isset($job['tokens']) && is_array($job['tokens']) ? $job['tokens'] : array(),
			'zones'   => isset($job['zones']) && is_array($job['zones']) ? $job['zones'] : array(),
			'css'     => isset($job['css']) ? (string) $job['css'] : '',
		);
		if ('' === $new_state['css']) {
			$new_state['css'] = bitpype_design_compile_css($new_state['tokens']);
		}
		update_option('bitpype_design_state', $new_state);
		$reports[] = array('proposal_id' => $pid, 'action' => 'apply', 'ok' => true, 'snapshot_version' => $new_state['version']);
		bitpype_design_log('applied', 'Proposal #' . $pid . ' applied (design version ' . $new_state['version'] . ')');
		$changed = true;
	}

	foreach ((isset($data['undo']) && is_array($data['undo'])) ? $data['undo'] : array() as $job) {
		$pid   = isset($job['proposal_id']) ? (int) $job['proposal_id'] : 0;
		$snaps = get_option('bitpype_design_snapshots', array());
		if (! is_array($snaps) || ! isset($snaps[(string) $pid]['state'])) {
			$reports[] = array('proposal_id' => $pid, 'action' => 'undo', 'ok' => false, 'error' => 'No snapshot is stored for that change on this site');
			continue;
		}
		$restored = $snaps[(string) $pid]['state'];
		$restored['version'] = (int) bitpype_design_state()['version'] + 1;
		update_option('bitpype_design_state', $restored);
		$reports[] = array('proposal_id' => $pid, 'action' => 'undo', 'ok' => true, 'snapshot_version' => $restored['version']);
		bitpype_design_log('undone', 'Proposal #' . $pid . ' undone (snapshot restored)');
		$changed = true;
	}

	if ($reports) {
		bitpype_connector_request('POST', '/design/report', array('results' => $reports), true);
	}
	update_option('bitpype_design_synced_at', time());
	if ($changed || ! empty($data['want_census'])) {
		bitpype_connector_push_census();
	}
}

// ---------------------------------------------------------------------
// Preview — staged state for ONE request, token-validated live
// ---------------------------------------------------------------------

function bitpype_design_preview_state() {
	static $resolved = null;
	static $done = false;
	if ($done) {
		return $resolved;
	}
	$done = true;
	if (! isset($_GET['bitpype_preview']) || '' === bitpype_connector_site_key()) { // phpcs:ignore WordPress.Security.NonceVerification
		return null;
	}
	$token  = sanitize_text_field(wp_unslash($_GET['bitpype_preview'])); // phpcs:ignore WordPress.Security.NonceVerification
	$result = bitpype_connector_request('GET', '/design/preview?token=' . rawurlencode($token), null, true);
	if (200 !== $result['code'] || empty($result['data']['data'])) {
		return null;
	}
	$resolved = $result['data']['data'];
	return $resolved;
}

function bitpype_design_maybe_preview() {
	if (null !== bitpype_design_preview_state()) {
		if (! defined('DONOTCACHEPAGE')) {
			define('DONOTCACHEPAGE', true);
		}
	}
}
add_action('init', 'bitpype_design_maybe_preview');

/** Effective design state for this request (preview wins). */
function bitpype_design_effective_state() {
	$preview = bitpype_design_preview_state();
	if (null !== $preview) {
		return array(
			'tokens' => isset($preview['tokens']) && is_array($preview['tokens']) ? $preview['tokens'] : array(),
			'zones'  => isset($preview['zones']) && is_array($preview['zones']) ? $preview['zones'] : array(),
			'css'    => isset($preview['css']) ? (string) $preview['css'] : '',
			'preview' => true,
		);
	}
	$state = bitpype_design_state();
	$state['preview'] = false;
	return $state;
}

// ---------------------------------------------------------------------
// Rendering — the Layer 1 CSS + Google Fonts + Layer 2 zones
// ---------------------------------------------------------------------

function bitpype_design_enqueue_fonts() {
	if ('connected' !== bitpype_connector_status() && null === bitpype_design_preview_state()) {
		return;
	}
	$state   = bitpype_design_effective_state();
	$google  = bitpype_design_google_fonts();
	$stacks  = bitpype_design_font_stacks();
	$families = array();
	foreach (array('heading_font', 'body_font') as $token) {
		if (! empty($state['tokens'][$token]) && isset($google[$state['tokens'][$token]])) {
			$families[$google[$state['tokens'][$token]]] = true;
		}
	}
	if ($families) {
		$query = array();
		foreach (array_keys($families) as $family) {
			$query[] = 'family=' . str_replace(' ', '+', $family) . ':wght@400;600;700';
		}
		wp_enqueue_style(
			'bitpype-design-fonts',
			'https://fonts.googleapis.com/css2?' . implode('&', $query) . '&display=swap',
			array(),
			null
		);
	}
}
add_action('wp_enqueue_scripts', 'bitpype_design_enqueue_fonts', 5);

function bitpype_design_print_layer() {
	if ('connected' !== bitpype_connector_status() && null === bitpype_design_preview_state()) {
		return;
	}
	$state = bitpype_design_effective_state();
	$css   = isset($state['css']) ? (string) $state['css'] : '';
	if ('' === $css && ! empty($state['tokens'])) {
		$css = bitpype_design_compile_css($state['tokens']);
	}
	if (! empty($state['preview'])) {
		echo "<!-- bitpype-design-preview -->\n";
	}
	if ('' !== $css) {
		echo '<style id="bitpype-design-layer"' . (! empty($state['preview']) ? ' data-bitpype-preview="1"' : '') . ">\n"
			. $css . "\n</style>\n"; // phpcs:ignore WordPress.Security.EscapeOutput — CSS compiled from validated enum/hex tokens only.
	}
}
add_action('wp_head', 'bitpype_design_print_layer', 999);

function bitpype_design_zone_colors($zone, $tokens) {
	$accent = isset($zone['fields']['accent']) ? $zone['fields']['accent'] : 'primary';
	if ('dark' === $accent) {
		return array('#1f2937', '#ffffff');
	}
	if ('light' === $accent) {
		return array('#f3f4f6', '#111827');
	}
	$bg = ! empty($tokens['primary_color']) ? $tokens['primary_color'] : '#155e63';
	return array($bg, '#ffffff');
}

/**
 * Render one BitPype zone (or nothing, when it must not appear).
 *
 * @param string $zone_id Zone id from the shortcode/block.
 * @return string HTML.
 */
function bitpype_connector_render_zone($zone_id) {
	$zone_id = sanitize_key((string) $zone_id);
	if ('' === $zone_id || '' === bitpype_connector_site_key()) {
		return '';
	}
	if ('connected' !== bitpype_connector_status() && null === bitpype_design_preview_state()) {
		return '';
	}
	$state = bitpype_design_effective_state();
	if (! isset($state['zones'][$zone_id]) || ! is_array($state['zones'][$zone_id])) {
		return '';
	}
	$zone   = $state['zones'][$zone_id];
	$fields = isset($zone['fields']) && is_array($zone['fields']) ? $zone['fields'] : array();
	list($bg, $fg) = bitpype_design_zone_colors($zone, $state['tokens']);
	$align = (isset($fields['align']) && 'left' === $fields['align']) ? 'left' : 'center';
	$type  = isset($zone['type']) ? (string) $zone['type'] : 'cta';
	$style = 'background-color:' . $bg . ';color:' . $fg . ';text-align:' . $align . ';'
		. ('hero' === $type ? 'padding:64px 24px;' : ('banner' === $type ? 'padding:20px 24px;' : 'padding:40px 24px;'));
	$html  = '<section class="bitpype-zone bitpype-zone-' . esc_attr($type) . '" data-bitpype-zone="' . esc_attr($zone_id) . '" style="' . esc_attr($style) . '">';
	if (! empty($fields['headline'])) {
		$html .= ('hero' === $type ? '<h2' : '<h3') . ' class="bitpype-zone-headline" style="margin:0 0 10px;color:inherit">'
			. esc_html($fields['headline']) . ('hero' === $type ? '</h2>' : '</h3>');
	}
	if (! empty($fields['subtext'])) {
		$html .= '<p class="bitpype-zone-subtext" style="margin:0 auto 16px;max-width:640px;color:inherit">' . esc_html($fields['subtext']) . '</p>';
	}
	if (! empty($fields['button_text']) && ! empty($fields['button_url'])) {
		$html .= '<a class="bitpype-zone-button" href="' . esc_url($fields['button_url']) . '" style="display:inline-block;padding:12px 26px;border-radius:6px;background-color:#ffffff;color:#111827;text-decoration:none;font-weight:600">'
			. esc_html($fields['button_text']) . '</a>';
	}
	$html .= '</section>';
	return $html;
}

/**
 * [bitpype_zone id="spring-offer"] shortcode.
 *
 * @param array $atts Shortcode attributes.
 * @return string
 */
function bitpype_connector_zone_shortcode($atts) {
	$atts = shortcode_atts(array('id' => ''), is_array($atts) ? $atts : array(), 'bitpype_zone');
	return bitpype_connector_render_zone((string) $atts['id']);
}
add_shortcode('bitpype_zone', 'bitpype_connector_zone_shortcode');

/**
 * Server-side render callback for the bitpype/zone block.
 *
 * @param array $attributes Block attributes.
 * @return string
 */
function bitpype_connector_render_zone_block($attributes) {
	$zone_id = is_array($attributes) && isset($attributes['zoneId']) ? (string) $attributes['zoneId'] : '';
	return bitpype_connector_render_zone($zone_id);
}

/**
 * Register the zone block (dynamic — rendered by PHP above).
 */
function bitpype_connector_register_zone_block() {
	wp_register_script(
		'bitpype-connector-zone-block',
		plugins_url('assets/zone-block.js', BITPYPE_CONNECTOR_FILE),
		array('wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components'),
		BITPYPE_CONNECTOR_VERSION,
		true
	);
	register_block_type(
		'bitpype/zone',
		array(
			'editor_script'   => 'bitpype-connector-zone-block',
			'render_callback' => 'bitpype_connector_render_zone_block',
			'attributes'      => array(
				'zoneId' => array(
					'type'    => 'string',
					'default' => '',
				),
			),
		)
	);
}
add_action('init', 'bitpype_connector_register_zone_block');

/**
 * Hand the block editor the current zone list (labels only).
 */
function bitpype_connector_zone_block_editor_data() {
	$state = bitpype_design_state();
	$zones = array();
	foreach ($state['zones'] as $id => $zone) {
		$headline = isset($zone['fields']['headline']) ? (string) $zone['fields']['headline'] : '';
		$zones[]  = array(
			'label' => (isset($zone['type']) ? $zone['type'] : 'section') . ': ' . ($headline ? $headline : $id) . ' (' . $id . ')',
			'value' => (string) $id,
		);
	}
	wp_localize_script('bitpype-connector-zone-block', 'bitpypeBlockZones', $zones);
}
add_action('enqueue_block_editor_assets', 'bitpype_connector_zone_block_editor_data');
