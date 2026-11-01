<?php
/**
 * BitPype Connector — form rendering (shortcode + Gutenberg block).
 *
 * Rendering goes through BitPype's own in-page form embed
 * (form-embed.js + the public form endpoints), exactly like forms on
 * BitPype-hosted sites: the embed div carries the form's public
 * token, the BitPype app address, and — for attribution — this page's
 * own URL, which BitPype records on the LeadScout event so the owner
 * can see the submission came from this WordPress page.
 *
 * Fail-closed states (not connected, disconnected, revoked) render
 * NOTHING — no error text ever reaches a visitor.
 *
 * @package BitpypeConnector
 */

if (! defined('ABSPATH')) {
	exit;
}

/**
 * Find one form in the cached list by id.
 *
 * @param int $form_id Form id from the shortcode/block.
 * @return array|null
 */
function bitpype_connector_form_by_id($form_id) {
	foreach (bitpype_connector_cached_forms() as $form) {
		if ((int) $form['id'] === (int) $form_id) {
			return $form;
		}
	}
	return null;
}

/**
 * Render one BitPype form (or nothing, when it must not appear).
 *
 * @param int $form_id Form id.
 * @return string HTML.
 */
function bitpype_connector_render_form($form_id) {
	$form_id = absint($form_id);
	if ($form_id <= 0 || '' === bitpype_connector_site_key()) {
		return '';
	}
	bitpype_connector_maybe_refresh_status();
	if ('connected' !== bitpype_connector_status()) {
		return '';
	}
	$form = bitpype_connector_form_by_id($form_id);
	if (null === $form) {
		// First use on this install: pull the form list once, then decide.
		bitpype_connector_fetch_forms();
		$form = bitpype_connector_form_by_id($form_id);
		if (null === $form) {
			return '';
		}
	}
	$app_url = bitpype_connector_app_url();
	if ('' === $app_url) {
		return '';
	}
	$request_uri = isset($_SERVER['REQUEST_URI']) ? sanitize_text_field(wp_unslash($_SERVER['REQUEST_URI'])) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
	$source      = esc_url_raw(home_url($request_uri));
	static $script_printed = false;
	$script = '';
	if (! $script_printed) {
		$script_printed = true;
		$script         = '<script src="' . esc_url($app_url . '/js/form-embed.js?v=wp1') . '" defer data-bitpype-form-script="1"></script>';
	}
	return '<div class="bitpype-form-embed" data-bitpype-managed="1" data-bitpype-form-embed="'
		. esc_attr($form['token']) . '" data-bitpype-api="' . esc_url($app_url)
		. '" data-bitpype-source="' . esc_url($source) . '"></div>' . $script;
}

/**
 * [bitpype_form id="123"] shortcode.
 *
 * @param array $atts Shortcode attributes.
 * @return string
 */
function bitpype_connector_shortcode($atts) {
	$atts = shortcode_atts(array('id' => 0), is_array($atts) ? $atts : array(), 'bitpype_form');
	return bitpype_connector_render_form(absint($atts['id']));
}
add_shortcode('bitpype_form', 'bitpype_connector_shortcode');

/**
 * Server-side render callback for the bitpype/form block.
 *
 * @param array $attributes Block attributes.
 * @return string
 */
function bitpype_connector_render_block($attributes) {
	$form_id = is_array($attributes) && isset($attributes['formId']) ? absint($attributes['formId']) : 0;
	return bitpype_connector_render_form($form_id);
}

/**
 * Register the Gutenberg block (dynamic — rendered by PHP above).
 */
function bitpype_connector_register_block() {
	wp_register_script(
		'bitpype-connector-block',
		plugins_url('assets/block.js', BITPYPE_CONNECTOR_FILE),
		array('wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components'),
		BITPYPE_CONNECTOR_VERSION,
		true
	);
	register_block_type(
		'bitpype/form',
		array(
			'editor_script'   => 'bitpype-connector-block',
			'render_callback' => 'bitpype_connector_render_block',
			'attributes'      => array(
				'formId' => array(
					'type'    => 'number',
					'default' => 0,
				),
			),
		)
	);
}
add_action('init', 'bitpype_connector_register_block');

/**
 * Hand the block editor the workspace's form names (labels only —
 * the render callback resolves the embed token server-side).
 */
function bitpype_connector_block_editor_data() {
	$forms = array();
	foreach (bitpype_connector_cached_forms() as $form) {
		$forms[] = array(
			'label' => $form['name'] . ' (#' . (int) $form['id'] . ')',
			'value' => (int) $form['id'],
		);
	}
	wp_localize_script('bitpype-connector-block', 'bitpypeBlockForms', $forms);
}
add_action('enqueue_block_editor_assets', 'bitpype_connector_block_editor_data');
