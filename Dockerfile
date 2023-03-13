FROM opendronemap/odm:2.6.4
MAINTAINER Piero Toffanin <pt@masseranolabs.com>

EXPOSE 3000

USER root

RUN printf "deb http://old-releases.ubuntu.com/ubuntu/ hirsute main restricted\ndeb http://old-releases.ubuntu.com/ubuntu/ hirsute-updates main restricted\ndeb http://old-releases.ubuntu.com/ubuntu/ hirsute universe\ndeb http://old-releases.ubuntu.com/ubuntu/ hirsute-updates universe\ndeb http://old-releases.ubuntu.com/ubuntu/ hirsute multiverse\ndeb http://old-releases.ubuntu.com/ubuntu/ hirsute-updates multiverse\ndeb http://old-releases.ubuntu.com/ubuntu/ hirsute-backports main restricted universe multiverse" > /etc/apt/sources.list

RUN apt-get update && apt-get install -y curl gpg-agent
RUN curl --silent --location https://deb.nodesource.com/setup_10.x | bash -
RUN apt-get install -y nodejs npm unzip p7zip-full && npm install -g nodemon && \
    ln -s /code/SuperBuild/install/bin/untwine /usr/bin/untwine && \
    ln -s /code/SuperBuild/install/bin/entwine /usr/bin/entwine && \
    ln -s /code/SuperBuild/install/bin/pdal /usr/bin/pdal


RUN mkdir /var/www

WORKDIR "/var/www"
COPY . /var/www

RUN npm install && mkdir tmp

ENTRYPOINT ["/usr/bin/node", "/var/www/index.js"]
