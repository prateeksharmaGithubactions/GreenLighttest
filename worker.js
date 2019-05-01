const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { BigQuery } = require('@google-cloud/bigquery');
const { JWT } = require('google-auth-library');
const bigquery = new BigQuery();

/**
 * Endpoint that starts the process of collecting data from
 * a specific user
 */
router.post('/insert', (req, res) => {
  var body = JSON.parse(req.body);
  try {
    insertUser(body.user, body.config, res);
  } catch (err) {
    console.log(err);
  }
})

/**
 * Processes an induvidual users.
 * 
 * @param user The Admin Directory User object
 * @param config Configuration object containing parameters and secrets
 */
async function insertUser(user, config, res) {
  let rows = [];
  console.log('GRIL: Starting checking user ' + user.primaryEmail);

  // uses the credentials for the Service Account with 
  // G Suite Domain-Wide Delegation of Authority enabled
  // subject is the user to be processed
  const client = await new JWT({
    email: config.secretEmailKey,
    key: config.secretPrivateKey.replace(/\\n/g, '\n'),
    subject: user.primaryEmail
  });
  const auth = await client.createScoped(
    ['https://mail.google.com/']
  );
  const gmail = google.gmail({ version: 'v1', auth });
  
  // get data for the user
  let userData = getUserData(user);

  // fetch all labels for the user
  var response = await gmail.users.labels.list({
    'userId': user.primaryEmail
  });
  let labelData;
  let messagesData;
  var labels = response.data.labels;
  var labelFound;
  if (!labels || labels.length === 0) {
    console.log('No labels found');
  } else {
    for (var k = 0; k < labels.length; k++) {
      var label = labels[k];

      if (label.name === config.labelName) {
        labelFound = true;
        // get label data for user
        labelData = await getLabelData(labels, label, user, gmail);
        // get messages data for user
        messagesData = await getMessagesData(user, label.id, gmail, config.domain);
        break;
      }
    }
  }
  rows.push({...userData, ...labelData, ...messagesData});
  // TODO: Remove createLabel from config
  if (!labelFound && config.createLabel) {
    // user does not have the label, let's push it
    await gmail.users.labels.create({
      'userId': user.primaryEmail,
      'resource': {
        'name': config.labelName,
        'labelListVisibility': 'labelShow',
        'messageListVisibility': 'show'
      }
    });
  }

  if (rows.length > 0) {
    await bigquery
      .dataset(config.datasetId)
      .table(config.tableId)
      .insert(rows);
  }
  res.status(200).send();
}

// returns the value of a key in an email header
function getHeaderValue(headers, key) {
  let header = headers.find(header => header.name === key)
  return header ? header.value : '';
}

// returns the user data of specific user
function getUserData(user) {
  let userData = {
    timestamp: new Date(),
    email: user.primaryEmail,
    guid: user.id,
    orgUnitPath: user.orgUnitPath,
    suspended: user.suspended,
  }
  let customSchemas = user.customSchemas;

  if (customSchemas && customSchemas.PwCGCDS) {
    userData.employeetype = customSchemas.PwCGCDS.employeetype;
    userData.pwcJobFamilyGroupName = customSchemas.PwCGCDS.pwcJobFamilyGroupName;
    userData.GlobalLoSLevel1 = customSchemas.PwCGCDS.GlobalLoSLevel1;
    userData.LocalLOSLevel1 = customSchemas.PwCGCDS.LocalLOSLevel1;
    userData.pwcJobFamilyName = customSchemas.PwCGCDS.pwcJobFamilyName;
    userData.GlobalGrade = customSchemas.PwCGCDS.GlobalGrade;
  }
  return userData;
}

// returns the number of filter rules applied to the specific label
// by the specific user
async function getFilterRules(user, labelId, gmail) {
  var filtersResponse = await gmail.users.settings.filters.list({
    'userId': user.primaryEmail
  });
  let filters = filtersResponse.data.filter && filtersResponse.data.filter.filter(function (filter) {
    if (!filter.action) {
      return false;
    }
    let labelIds = filter.action.addLabelIds;
    if (labelIds) {
      return labelIds.indexOf(labelId) !== -1;
    }
    return false;
  });
  return filters ? filters.length : 0;
}

// returns the label data for a specific user and a specific label
async function getLabelData(labels, label, user, gmail) {
  var subLabel = labels.find(function(aLabel) {
    return aLabel.name !== label.name && aLabel.name.startsWith(label.name);
  });
  let hasSubLabels = subLabel ? true : false;

  let labelDetails = await gmail.users.labels.get({
    'userId': user.primaryEmail,
    'id': label.id
  });

  let labelData = {
    filterRules: await getFilterRules(user, label.id, gmail),
    labelId: label.id,
    labelName: label.name,
    messages: labelDetails.data.messagesTotal,
    messagesUnread: labelDetails.data.messagesUnread,
    threads: labelDetails.data.threadsTotal,
    threadsUnread: labelDetails.data.threadsUnread,
    hasSubLabels: hasSubLabels
  }

  return labelData;
}

// returns metadata for messages in a specific label for 
// a specific user
async function getMessagesData(user, labelId, gmail, domain) {
  let messagesData = {
    countedMessages: 0,
    totalEstimatedSize: 0,
    nbrExternalIncoming: 0,
    nbrExternalOutgoing: 0,
    mostRecentEmail: 0,
    hasAttachments: 0
  };

  let messages = await gmail.users.messages.list({
    'maxResults': 500,
    'userId': user.primaryEmail,
    'labelIds': [labelId],
  });
  messages = messages.data.messages;
  if (messages) {
    messagesData.countedMessages = messages.length;

    for (let i = 0; i < messages.length; i++) {
      let message = messages[i];
      let messageDetails = await gmail.users.messages.get({
        'userId': user.primaryEmail,
        'id': message.id,
      });
      messageDetails = messageDetails.data;

      let headers = messageDetails.payload.headers;

      let toHeader = getHeaderValue(headers, 'To');
      let fromHeader = getHeaderValue(headers, 'From');
      let bccHeader = getHeaderValue(headers, 'Bcc');
      let ccHeader = getHeaderValue(headers, 'Cc');

      messagesData.totalEstimatedSize += messageDetails.sizeEstimate;
      if (messageDetails.internalDate > messagesData.mostRecentEmail) {
        messagesData.mostRecentEmail = messageDetails.internalDate;
      }
      if (messageDetails.payload.mimeType !== 'multipart/alternative') {
        messagesData.hasAttachments++;
      }

      if (fromHeader.indexOf(user.primaryEmail) !== -1) {
        // the email is sent from me
        let allReceivers = [...toHeader.split(','), ccHeader, bccHeader]
        let isExternalReceiver = allReceivers.find(receiver => {
          return receiver.indexOf('@' + domain) === -1;
        });

        if (isExternalReceiver) {
          // the email is sent outside my organization
          messagesData.nbrExternalOutgoing++;
        }
      } else if (fromHeader.indexOf('@' + domain) === -1) {
        // the email comes from outside my organization
        messagesData.nbrExternalIncoming++;
      }
    }
  }
  return messagesData;
}
module.exports = router;
