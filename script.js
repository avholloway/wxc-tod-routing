import got from 'got';
import date from 'date-and-time';

export default defineComponent({
  props: {
    webex: {
      type: "app",
      app: "cisco_webex_custom_app",
    }
  },
  async run({ steps, $ }) {
    
    const html = content => `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="X-UA-Compatible" content="IE=edge">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Time of Day Routing</title>
      <style>
        body { color: #333; font-family: Tahoma, sans-serif; }
        .container { margin-left: 2em; }
        .container div { margin-top: 1em; }
        .rule, .mode { text-decoration: underline; }
        button { font-size: 1.25em; padding: .25em .5em; }
      </style>
      <script>
        function save_mode(e, url) {
          e.innerText = 'Saving...';
          document.querySelectorAll('button').forEach(button => button.disabled = true);
          window.location.href = url;
        }
      </script>
    </head>
    <body>
      <div class="container">
        ${content}
      </div>
    </body>
    </html>`;

    const locationName = steps.trigger.event.query.locationName;
    const queueName = steps.trigger.event.query.queueName;
    if (!locationName || !queueName) {
      const error = `Missing required query parameters: locationName and queueName`;
      await $.respond({ status: 200, body: html(error) });
      return $.flow.exit(error);
    }

    const webex_api_options = {
      prefixUrl: `https://webexapis.com/v1/telephony/config/`,
      headers: {
        'Authorization': `Bearer ${this.webex.$auth.oauth_access_token}`
      }
    };

    const got_api_client = got.extend(webex_api_options);

    // define our target call queue by name and location
    const target_queue = {name: queueName, locationName: locationName};
    console.log({target_queue});

    // find and then update our target call queue object
    const { queues } = await got_api_client.get('queues').json();
    for (const queue of queues) {
      if (queue.locationName === target_queue.locationName && queue.name === target_queue.name) {
        console.log('found our queue:', {queue});
        Object.assign(target_queue, queue);
        break;
      }
    }

    console.log('Target Queue:', {name: target_queue.name, location: target_queue.locationName, phoneNumber: target_queue.phoneNumber, extension: target_queue.extension});

    // get call queue forwarding details
    let { callForwarding } = await got_api_client.get(`locations/${target_queue.locationId}/queues/${target_queue.id}/callForwarding`).json();
    Object.assign(target_queue, {callForwarding});
    console.log('original callForwarding settings');
    console.log({callForwarding});
    console.log({rules: callForwarding.rules});

    // alias our ruleset statuses for easier referencing
    let rule1 = callForwarding.rules[0].enabled;
    let rule2 = callForwarding.rules[1].enabled;
    let rule3 = callForwarding.rules[2].enabled;
    let rule4 = callForwarding.rules[3].enabled;
    console.log({rule1, rule2, rule3, rule4});

    let current_mode = 0;
    if (!rule1 && rule2 && rule3 && rule4) {
      current_mode = 1;
    } else if (rule1) {
      current_mode = 2;
    } else if (!rule1 && !rule2 && !rule3 && rule4) {
      current_mode = 3;
    }

    // routing modes
    const modes = {
      1: 'Normal Call Routing',
      2: 'Forced Business Hours Routing',
      3: 'Forced After Hours Routing'
    }

    // routing rules
    const rules = {
      1: 'Forced Business Hours Routing',
      2: 'One-Off Special Day Routing',
      3: 'Normal Business Hours Routing',
      4: 'Normal After Hours Routing',
    };

    async function render_page(current_rule) {
      const workflow_trigger = steps.trigger.event.headers.host;

      const url_base = `https://${workflow_trigger}?locationName=${target_queue.locationName}&queueName=${target_queue.name}`;
      const url_normal = `${url_base}&mode=1`;
      const url_force_during = `${url_base}&mode=2`;
      const url_force_after = `${url_base}&mode=3`;
      
      const content = `<div><h1>${target_queue.name} in ${target_queue.locationName} (${target_queue.phoneNumber} / x${target_queue.extension})</h1></div>
        <div><h2>Current Routing Rule <span class="rule">${rules[current_rule]}</span> is Matching</h2></div>
        <div><h2>Current Routing Mode <span class="mode">${modes[current_mode]}</span> is Active</h2></div>
        <div><h3>Switch Mode:</h3></div>
        <div style="display: ${[2, 3].includes(current_mode) ? 'block' : 'none'}"><button onclick="save_mode(this, '${url_normal}')">${modes[1]}</button></div>
        <div style="display: ${[1, 3].includes(current_mode) ? 'block' : 'none'}"><button onclick="save_mode(this, '${url_force_during}')">${modes[2]}</button></div>
        <div style="display: ${[1, 2].includes(current_mode) ? 'block' : 'none'}"><button onclick="save_mode(this, '${url_force_after}')">${modes[3]}</button></div>`;

      await $.respond({ status: 200, body: html(content) });
    }

    // -----------------------------------
    // process the new mode change request

    const new_mode = parseInt(steps.trigger.event.query.mode);
    if ([1, 2, 3].includes(new_mode)) {
      console.log(`processing new mode ${new_mode}`);

      // copy the callForwarding object, as we'll need a mutated copy of it
      const payload = {...callForwarding};

      // default all rules to on, and then we'll turn off the ones we need later
      for (let i = 0, j = payload.rules.length; i < j; i++) {
        payload.rules[i].enabled = true;
      }

      // turn off only those we need, after having defaulted them all on
      switch (new_mode) {
        case 1:
          payload.rules[0].enabled = false;
          break;
        case 3:
          payload.rules[0].enabled = false;
          payload.rules[1].enabled = false;
          payload.rules[2].enabled = false;
          break;
      }

      // http put to update callForwarding settings here
      console.log('sending callForwarding change request');
      console.log({payload});
      console.log({rules: payload.rules});
      for (const rule of payload.rules) {
        await got_api_client.put(`locations/${target_queue.locationId}/queues/${target_queue.id}/callForwarding/selectiveRules/${rule.id}`, {json: {name: rule.name, enabled: rule.enabled}});
      }

      // since we're done processing a change, let's redirect the user back to the main
      // so we can drop the mode= param and we can pull a fresh config to show them

      await $.respond({ status: 302, headers: {'Location': `/?locationName=${locationName}&queueName=${queueName}`} });
      return $.flow.exit();
    
    }

    // -------------------------------------------------------
    // get current matching rule and report it to the web page
    
    if (rule1) {
      console.log(`rule 1: ${rules[1]}, is active`);
      await render_page(1);
      return $.flow.exit();
    }

    if (!rule1 && !rule2 && !rule3 && rule4) {
      console.log(`rule 4: ${rules[4]}, is active`);
      await render_page(4);
      return $.flow.exit();
    }

    // the remaining rules require schedules to be compared against current date & time

    // get the call queue's timezone
    const queue_detail = await got_api_client.get(`locations/${target_queue.locationId}/queues/${target_queue.id}`).json();
    Object.assign(target_queue, queue_detail);
    console.log({timezone: queue_detail.timeZone});

    // get the current date & time for the target timezone
    const { datetime } = await got(`http://worldtimeapi.org/api/timezone/${target_queue.timeZone}`).json();
    const date_part = datetime.split('T')[0];
    const today = date.parse(date_part, 'YYYY-MM-DD');
    const time_part = datetime.split('T')[1].substring(0, 5);
    const now = date.parse(time_part, 'HH:mm');
    console.log({today: date.format(today, 'YYYY-MM-DD')}, {now: date.format(now, 'HH:mm')});

    // get the list of schedules for the site
    const { schedules } = await got_api_client.get(`locations/${target_queue.locationId}/schedules`).json();

    // get the details of the schedules
    for (let i = 0, j = schedules.length; i < j; i++) {
      const schedule_detail = await got_api_client.get(`locations/${schedules[i].locationId}/schedules/${schedules[i].type}/${schedules[i].id}`).json();
      schedules[i].events = [];

      // get the details of the schedule events
      for (let k = 0, l = schedule_detail.events.length; k < l; k++) {
        const event_detail = await got_api_client.get(`locations/${schedules[i].locationId}/schedules/${schedules[i].type}/${schedules[i].id}/events/${schedule_detail.events[k].id}`).json();
        schedules[i].events.push(event_detail);
      }
    }

    if (rule2) {
      console.log(`rule 2: ${rules[2]} is enabled; checking if active`);
      
      // get the rule details so we know the name of its schedule
      const rule_detail = await got_api_client.get(`locations/${target_queue.locationId}/queues/${target_queue.id}/callForwarding/selectiveRules/${target_queue.callForwarding.rules[1].id}`).json();

      // find which schedule this rule is using and store its events
      let events = [];
      for (const schedule of schedules) {
        if (schedule.name === rule_detail.holidaySchedule) {
          console.log({schedule: schedule.name});
          events = [...schedule.events];
          break;
        }
      }

      // iterate the events and see if we're in one of them right now
      let match = false;
      for (const event of events) {
        console.log({event});

        // check for a match on date alone
        const start_date = date.parse(event.startDate, 'YYYY-MM-DD');
        const end_date = date.parse(event.endDate, 'YYYY-MM-DD');
        if (today >= start_date && today <= end_date) {
          console.log('today falls between event dates');
          match = true;
        }

        // do we need to check for a time match too?
        if (match && !event.allDayEnabled) {
          console.log('the event has a time range we must also check');
          const start_time = date.parse(event.startTime, 'HH:mm');
          const end_time = date.parse(event.endTime, 'HH:mm');
          if (now < start_time || now > end_time) {
            console.log('the time now, falls outside of the event times');
            match = false;
          }
        }

        // if we matched an event, then no need to keep checking
        if (match) break;

      }

      if (match) {
        console.log(`rule 2: ${rules[2]} is active`);
        await render_page(2);
        return $.flow.exit();
      }

    }

    if (rule3) {
      console.log(`rule 3: ${rules[3]}, is enabled; checking if active`);

      // get the rule details so we know the name of the schedule for this rule
      const rule_detail = await got_api_client.get(`locations/${target_queue.locationId}/queues/${target_queue.id}/callForwarding/selectiveRules/${target_queue.callForwarding.rules[2].id}`).json();

      // find which schedule this rule is using and store its events
      let events = [];
      for (const schedule of schedules) {
        if (schedule.name === rule_detail.businessSchedule) {
          console.log({schedule: schedule.name});
          events = [...schedule.events];
          break;
        }
      }

      // iterate the events and see if we're in one of them right now
      let match = false;
      for (const event of events) {
        console.log({event});
        console.log({weekday: event.recurrence.recurWeekly});

        // check for a match on day of week name
        const dow = date.format(today, 'dddd').toString().toLowerCase();
        if (event.recurrence.recurWeekly[dow]) {
          console.log(`today's dow (${dow}) matches event ${event.name}'s weekday`);
          match = true;
        }

        // do we need to check for a time match too?
        if (match && !event.allDayEnabled) {
          console.log('the event has a time range we must also check');
          const start_time = date.parse(event.startTime, 'HH:mm');
          const end_time = date.parse(event.endTime, 'HH:mm');
          if (now < start_time || now > end_time) {
            console.log('the time now, falls outside of the event times');
            match = false;
          }
        }

        // if we matched an event, then no need to keep checking
        if (match) break;

      }

      if (match) {
        console.log(`rule 3: ${rules[3]} is active`);
        await render_page(3);
      } else {
        console.log(`rule 4: ${rules[4]} is active`);
        await render_page(4);
      }

      return $.flow.exit();
    }
    
  },
})
