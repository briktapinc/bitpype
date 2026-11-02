<?php
/**
 * BitPype Connector — WP-admin settings screen + notices.
 *
 * One small screen (Settings → BitPype): connection status, the
 * workspace's forms with their shortcodes, Disconnect / Reconnect.
 * Every string printed here is escaped at output; the two POST
 * actions are nonce-checked and capability-gated.
 *
 * @package BitpypeConnector
 */

if (! defined('ABSPATH')) {
	exit;
}

function bitpype_connector_add_settings_page() {
	add_options_page(
		'BitPype',
		'BitPype',
		'manage_options',
		'bitpype-connector',
		'bitpype_connector_render_settings'
	);
}
add_action('admin_menu', 'bitpype_connector_add_settings_page');

/**
 * Guidance shown when this copy's registration link was already used.
 *
 * @return string
 */
function bitpype_connector_spent_message() {
	return 'This copy of the BitPype plugin has already connected a WordPress site. Each download connects one site. To connect this site, download a fresh copy from your BitPype portal (WordPress tab) and install that one instead.';
}

/**
 * Guidance shown when the owner revoked this site in the portal.
 *
 * @return string
 */
function bitpype_connector_revoked_message() {
	return 'This site was disconnected in your BitPype portal, so BitPype forms no longer appear here. To reconnect, download a fresh copy of the plugin from your BitPype portal (WordPress tab).';
}

/**
 * Admin-wide notices for states the owner must act on.
 */
function bitpype_connector_admin_notices() {
	if (! current_user_can('manage_options')) {
		return;
	}
	$status = bitpype_connector_status();
	if ('spent' === $status) {
		echo '<div class="notice notice-error"><p><strong>BitPype:</strong> ' . esc_html(bitpype_connector_spent_message()) . '</p></div>';
	} elseif ('revoked' === $status) {
		echo '<div class="notice notice-error"><p><strong>BitPype:</strong> ' . esc_html(bitpype_connector_revoked_message()) . '</p></div>';
	}
}
add_action('admin_notices', 'bitpype_connector_admin_notices');

/**
 * Handle this screen's POST actions, then refresh what we know:
 * an unregistered install retries its (single) registration, a
 * registered one refreshes status + the form list.
 */
function bitpype_connector_admin_init() {
	if (! current_user_can('manage_options')) {
		return;
	}
	if (isset($_POST['bitpype_action']) && isset($_POST['_wpnonce'])
		&& wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['_wpnonce'])), 'bitpype_connector_admin')) {
		$action = sanitize_text_field(wp_unslash($_POST['bitpype_action']));
		if ('disconnect' === $action && '' !== bitpype_connector_site_key()) {
			bitpype_connector_disconnect('manual');
		} elseif ('reconnect' === $action && '' !== bitpype_connector_site_key()) {
			bitpype_connector_ping('active');
		} elseif ('register' === $action && '' === bitpype_connector_site_key()) {
			bitpype_connector_register();
		} elseif ('design_sync' === $action && '' !== bitpype_connector_site_key()) {
			bitpype_connector_design_sync();
		}
	}
	$screen = get_current_screen();
	if (! $screen || 'settings_page_bitpype-connector' !== $screen->id) {
		return;
	}
	if ('' === bitpype_connector_site_key()) {
		if ('spent' !== bitpype_connector_status() && 'revoked' !== bitpype_connector_status()) {
			bitpype_connector_register();
		}
		return;
	}
	bitpype_connector_ping('status');
	bitpype_connector_fetch_forms();
	// Batch 117: keep the design chat's site map fresh and pick up
	// any owner-approved design work while the owner is here.
	bitpype_connector_design_sync();
	$census_sent = (int) get_option('bitpype_census_sent_at', 0);
	if (time() - $census_sent > 300) {
		bitpype_connector_push_census();
	}
}
add_action('admin_init', 'bitpype_connector_admin_init');

/**
 * The settings screen itself.
 */
function bitpype_connector_render_settings() {
	if (! current_user_can('manage_options')) {
		wp_die(esc_html__('You do not have permission to view this page.', 'bitpype-connector'));
	}
	$status = bitpype_connector_status();
	$forms  = bitpype_connector_cached_forms();
	echo '<div class="wrap">';
	echo '<h1>BitPype</h1>';

	if ('connected' === $status) {
		echo '<p><strong>' . esc_html__('Connected.', 'bitpype-connector') . '</strong> '
			. esc_html__('This WordPress site is connected to your BitPype account. Forms you place below appear on your pages, and their submissions arrive in your BitPype portal under LeadScout.', 'bitpype-connector')
			. '</p>';
	} elseif ('disconnected' === $status) {
		echo '<p><strong>' . esc_html__('Disconnected.', 'bitpype-connector') . '</strong> '
			. esc_html__('BitPype forms are hidden while disconnected. Your connection is saved — reconnect any time; no new download is needed.', 'bitpype-connector')
			. '</p>';
	} elseif ('revoked' === $status) {
		echo '<p>' . esc_html(bitpype_connector_revoked_message()) . '</p>';
	} elseif ('spent' === $status) {
		echo '<p>' . esc_html(bitpype_connector_spent_message()) . '</p>';
	} else {
		echo '<p>' . esc_html__('Not connected yet. The plugin connects itself to the BitPype account that downloaded it — if this message stays, check that this site can reach the internet, then use the button below.', 'bitpype-connector') . '</p>';
	}

	if ('connected' === $status || 'disconnected' === $status) {
		echo '<h2>' . esc_html__('Your BitPype forms', 'bitpype-connector') . '</h2>';
		if (empty($forms)) {
			echo '<p>' . esc_html__('No forms yet. Create and publish a form in your BitPype portal (Forms tab), then return here — it will appear in this list.', 'bitpype-connector') . '</p>';
		} else {
			echo '<table class="widefat striped" style="max-width:720px"><thead><tr><th>'
				. esc_html__('Form', 'bitpype-connector') . '</th><th>'
				. esc_html__('Shortcode — paste into any page or post', 'bitpype-connector')
				. '</th></tr></thead><tbody>';
			foreach ($forms as $form) {
				$shortcode = '' !== $form['shortcode'] ? $form['shortcode'] : '[bitpype_form id="' . (int) $form['id'] . '"]';
				echo '<tr><td>' . esc_html($form['name']) . '</td><td><code>' . esc_html($shortcode) . '</code></td></tr>';
			}
			echo '</tbody></table>';
			echo '<p>' . esc_html__('You can also add a form with the “BitPype Form” block in the page editor.', 'bitpype-connector') . '</p>';
		}
	}

	if ('connected' === $status) {
		$design = bitpype_design_state();
		echo '<h2>' . esc_html__('Design with BitPype', 'bitpype-connector') . '</h2>';
		echo '<p>' . esc_html__('In your BitPype portal (WordPress tab) you can chat about this site\'s design. The chat can only propose changes — to your site\'s overall look (colors, fonts) and to BitPype sections — and nothing is applied until you preview and approve it there. Before a change is applied, the plugin saves a snapshot, and you can undo it from the portal.', 'bitpype-connector') . '</p>';
		echo '<p>' . esc_html__('Current BitPype design state: version ', 'bitpype-connector') . (int) $design['version']
			. ' · ' . count($design['tokens']) . esc_html__(' look settings', 'bitpype-connector')
			. ' · ' . count($design['zones']) . esc_html__(' BitPype sections.', 'bitpype-connector') . '</p>';
		if (! empty($design['zones'])) {
			echo '<table class="widefat striped" style="max-width:720px"><thead><tr><th>'
				. esc_html__('Section', 'bitpype-connector') . '</th><th>'
				. esc_html__('Shortcode — paste into any page or post', 'bitpype-connector')
				. '</th></tr></thead><tbody>';
			foreach ($design['zones'] as $zone_id => $zone) {
				$label = (isset($zone['type']) ? (string) $zone['type'] : 'section')
					. (! empty($zone['fields']['headline']) ? ': ' . (string) $zone['fields']['headline'] : '');
				echo '<tr><td>' . esc_html($label) . '</td><td><code>[bitpype_zone id="' . esc_attr((string) $zone_id) . '"]</code></td></tr>';
			}
			echo '</tbody></table>';
		}
		$design_log = get_option('bitpype_design_log', array());
		if (is_array($design_log) && ! empty($design_log)) {
			echo '<h3>' . esc_html__('Recent design activity', 'bitpype-connector') . '</h3><ul style="margin:0;padding-left:1.25rem">';
			foreach (array_reverse(array_slice($design_log, -8)) as $entry) {
				echo '<li>' . esc_html(date_i18n(get_option('date_format') . ' ' . get_option('time_format'), (int) $entry['at']))
					. ' — ' . esc_html((string) $entry['summary']) . '</li>';
			}
			echo '</ul>';
		}
		echo '<form method="post" style="margin-top:12px">';
		wp_nonce_field('bitpype_connector_admin');
		echo '<input type="hidden" name="bitpype_action" value="design_sync" />';
		echo '<button type="submit" class="button">Check for approved design changes now</button>';
		echo '</form>';
	}

	echo '<form method="post" style="margin-top:24px">';
	wp_nonce_field('bitpype_connector_admin');
	if ('connected' === $status) {
		echo '<input type="hidden" name="bitpype_action" value="disconnect" />';
		echo '<button type="submit" class="button">Disconnect this site</button>';
		echo '<p class="description">' . esc_html__('Disconnecting hides your BitPype forms. Submissions you already received stay in your BitPype portal.', 'bitpype-connector') . '</p>';
	} elseif ('disconnected' === $status) {
		echo '<input type="hidden" name="bitpype_action" value="reconnect" />';
		echo '<button type="submit" class="button button-primary">Reconnect this site</button>';
	} elseif ('unregistered' === $status) {
		echo '<input type="hidden" name="bitpype_action" value="register" />';
		echo '<button type="submit" class="button button-primary">Connect now</button>';
	}
	echo '</form>';
	echo '</div>';
}
