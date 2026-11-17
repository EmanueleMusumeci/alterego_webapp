# Simulated AlterEGO base + vision PCs for webapp workflow tests (droplet only).
FROM node:10-alpine
RUN apk add --no-cache python3 bash openssh-server openssh-client procps coreutils grep \
 && deluser --remove-home node \
 && adduser -D -s /bin/bash -u 1001 alterego-vision \
 && adduser -D -s /bin/bash -u 1002 alterego-base \
 && sed -i 's/^\(alterego-[a-z]*\):!/\1:*/' /etc/shadow \
 && ssh-keygen -A
COPY fakeros.py /opt/fakeros.py
RUN chmod 755 /opt/fakeros.py && mkdir -p /fakeros-bin /opt/ros/noetic \
 && for c in roslaunch rosnode rostopic rosrun roscore killall; do ln -s /opt/fakeros.py /fakeros-bin/$c; done \
 && ln -s /opt/fakeros.py /usr/local/bin/sudo \
 && printf '#!/bin/sh\necho "${FAKE_IP:-10.88.0.111}"\n' > /usr/local/bin/hostname && chmod 755 /usr/local/bin/hostname \
 && echo 'export PATH=/fakeros-bin:$PATH' > /opt/ros/noetic/setup.bash
# base PC user
RUN su alterego-base -c 'mkdir -p ~/catkin_ws/devel ~/catkin_ws/src/AlterEGO_Adriano/alterego_robot/config \
      ~/catkin_ws/src/AlterEGO_Adriano/utils/alterego_battery_status ~/.ssh \
 && echo true > ~/catkin_ws/devel/setup.bash \
 && touch ~/catkin_ws/src/AlterEGO_Adriano/alterego_robot/config/SystemCheck.txt \
 && printf "#!/bin/sh\nexit 0\n" > ~/catkin_ws/src/AlterEGO_Adriano/utils/alterego_battery_status/battery_monitor.sh \
 && chmod 755 ~/catkin_ws/src/AlterEGO_Adriano/utils/alterego_battery_status/battery_monitor.sh \
 && ln -s /fakeros/battery.txt ~/catkin_ws/src/AlterEGO_Adriano/utils/alterego_battery_status/BatteryStatus.txt \
 && echo "export ROBOT_NAME=robot_adriano" > ~/.bashrc'
# vision PC user, with the key the webapp uses to reach the base
RUN su alterego-vision -c 'mkdir -p ~/AlterEGO_Adriano/catkin_ws/devel ~/.ssh \
 && echo true > ~/AlterEGO_Adriano/catkin_ws/devel/setup.bash \
 && printf "export ROBOT_NAME=robot_adriano\nexport AlterEgoVersion=2\n" > ~/.bashrc \
 && ssh-keygen -q -t rsa -b 2048 -m PEM -N "" -f ~/.ssh/id_rsa' \
 && cp /home/alterego-vision/.ssh/id_rsa.pub /home/alterego-base/.ssh/authorized_keys \
 && chown -R alterego-base /home/alterego-base/.ssh && chmod 700 /home/alterego-base/.ssh && chmod 600 /home/alterego-base/.ssh/authorized_keys
